import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ProjectsService } from "./projects.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { TemplateCatalogService } from "../catalog/template-catalog.service";

const audit = { log: jest.fn() } as unknown as AuditService;
// Catalog is only consulted to resolve an app's template logo; default to "no template known".
const catalog = { get: jest.fn().mockReturnValue(undefined) } as unknown as TemplateCatalogService;

// OWNER/ADMIN hold every granular permission; VIEWER holds none.
const ALL_PERMS = [
  "apps:deploy", "apps:config", "databases", "backups", "servers:manage",
  "servers:ops", "terminal", "bulk", "monitors", "projects", "integrations", "variables",
];

// Permissive per-resource-scoping defaults so non-scoping tests stay green; overridden per test.
function accessWith(access: Partial<TeamAccessService>): TeamAccessService {
  return {
    requireProjectAccess: jest.fn().mockResolvedValue(undefined),
    grantProjectAccess: jest.fn().mockResolvedValue(undefined),
    membershipAccess: jest.fn().mockResolvedValue(null),
    accessByTeam: jest.fn().mockResolvedValue(new Map()),
    ...access,
  } as unknown as TeamAccessService;
}

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>) {
  return new ProjectsService(prisma as PrismaService, accessWith(access), audit, catalog);
}

describe("ProjectsService", () => {
  it("creates a project with a default production environment", async () => {
    const create = jest.fn().mockResolvedValue({ id: "p1" });
    const prisma = {
      project: {
        create,
        findUnique: jest.fn().mockResolvedValue({ id: "p1", teamId: "t1", name: "web", environments: [{ id: "e1", name: "production", createdAt: new Date() }], createdAt: new Date() }),
      },
      application: { findMany: jest.fn().mockResolvedValue([]) },
      database: { findMany: jest.fn().mockResolvedValue([]) },
      server: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue(Role.OWNER),
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(ALL_PERMS)]])),
    } as unknown as TeamAccessService;
    const view = await make(prisma, access).create("u1", "t1", "web");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          teamId: "t1",
          name: "web",
          environments: { create: { name: "production", isDefault: true } },
        }),
      }),
    );
    expect(view.environments[0].name).toBe("production");
  });

  it("promotes the oldest surviving env to default when the default env is removed", async () => {
    const del = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      environment: {
        findUnique: jest.fn().mockResolvedValue({ id: "e1", projectId: "p1", isDefault: true, project: { teamId: "t1" } }),
        delete: del,
        findFirst: jest.fn().mockResolvedValue({ id: "e2" }),
        update,
      },
      application: { count: jest.fn().mockResolvedValue(0) },
      database: { count: jest.fn().mockResolvedValue(0) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access).removeEnvironment("u1", "e1");
    expect(del).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ where: { id: "e2" }, data: { isDefault: true } });
  });

  it("does not promote a sibling when a non-default env is removed", async () => {
    const findFirst = jest.fn();
    const prisma = {
      environment: {
        findUnique: jest.fn().mockResolvedValue({ id: "e2", projectId: "p1", isDefault: false, project: { teamId: "t1" } }),
        delete: jest.fn().mockResolvedValue({}),
        findFirst,
        update: jest.fn(),
      },
      application: { count: jest.fn().mockResolvedValue(0) },
      database: { count: jest.fn().mockResolvedValue(0) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access).removeEnvironment("u1", "e2");
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("forbids creating a project for a team the user can't write to", async () => {
    const access = {
      requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    await expect(make({} as PrismaService, access).create("u1", "t1", "web")).rejects.toThrow(/nope/);
  });

  it("get() returns resources enriched with url, server name, tags and engine", async () => {
    const prisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue({
          id: "p1", teamId: "t1", name: "web",
          environments: [{ id: "e1", name: "production", createdAt: new Date() }], createdAt: new Date(),
        }),
      },
      application: {
        findMany: jest.fn().mockResolvedValue([
          { id: "a1", name: "api", status: "RUNNING", environmentId: "e1", source: "GIT", domain: "x.com", https: true, tags: ["prod"], serverId: "s1" },
          { id: "a2", name: "stack", status: "RUNNING", environmentId: "e1", source: "COMPOSE", domain: null, https: true, hostPort: 9000, tags: [], serverId: "s1" },
        ]),
      },
      database: {
        findMany: jest.fn().mockResolvedValue([
          { id: "d1", name: "pg", status: "RUNNING", environmentId: "e1", engine: "POSTGRES", tags: [], serverId: "s1" },
        ]),
      },
      server: { findMany: jest.fn().mockResolvedValue([{ id: "s1", name: "web-1", publicIp: "203.0.113.7", publicIpv6: null }]) },
    } as unknown as PrismaService;
    const access = {
      teamRole: jest.fn().mockResolvedValue(Role.OWNER),
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(ALL_PERMS)]])),
    } as unknown as TeamAccessService;
    const out = await make(prisma, access).get("u1", "p1");
    const res = out.environments[0].resources!;
    const app = res.find((r) => r.id === "a1")!;
    expect(app.url).toBe("https://x.com");
    expect(app.serverName).toBe("web-1");
    expect(app.tags).toEqual(["prod"]);
    expect(app.source).toBe("GIT");
    const service = res.find((r) => r.id === "a2")!;
    expect(service.source).toBe("COMPOSE"); // grouped as a Service in the UI
    // Domainless but publishes a host port → reachable http://<serverIp>:<hostPort>.
    expect(service.url).toBe("http://203.0.113.7:9000");
    const db = res.find((r) => r.kind === "database")!;
    expect(db.engine).toBe("POSTGRES");
    expect(db.source).toBeNull();
    expect(db.serverName).toBe("web-1");
  });

  it("lists projects grouped by the user's teams with resource counts", async () => {
    const prisma = {
      project: {
        findMany: jest.fn().mockResolvedValue([
          { id: "p1", teamId: "t1", name: "web", environments: [{ id: "e1", name: "production", createdAt: new Date() }], createdAt: new Date() },
        ]),
      },
      application: { findMany: jest.fn().mockResolvedValue([{ id: "a1", environmentId: "e1" }]) },
      database: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = {
      accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: Role.ADMIN, restrictedAccess: false, accessedProjects: [], accessedResources: [] }]])),
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(ALL_PERMS)]])),
    } as unknown as TeamAccessService;
    const out = await make(prisma, access).list("u1");
    expect(out[0].environments[0].appCount).toBe(1);
    expect(out[0].canWrite).toBe(true);
  });

  it("refuses to remove a project whose environments still hold resources", async () => {
    const prisma = {
      project: { findUnique: jest.fn().mockResolvedValue({ id: "p1", teamId: "t1" }) },
      environment: { findMany: jest.fn().mockResolvedValue([{ id: "e1" }]) },
      application: { count: jest.fn().mockResolvedValue(1) },
      database: { count: jest.fn().mockResolvedValue(0) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access).remove("u1", "p1")).rejects.toThrow(ConflictException);
  });

  it("refuses to remove an environment that still holds resources", async () => {
    const prisma = {
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e1", projectId: "p1", project: { teamId: "t1" } }) },
      application: { count: jest.fn().mockResolvedValue(0) },
      database: { count: jest.fn().mockResolvedValue(2) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access).removeEnvironment("u1", "e1")).rejects.toThrow(ConflictException);
  });
});

describe("ProjectsService - custom icon", () => {
  const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  function pngB64(w = 128, h = 128): string {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "ascii");
    ihdr.writeUInt32BE(w, 8);
    ihdr.writeUInt32BE(h, 12);
    return Buffer.concat([sig, ihdr, IEND]).toString("base64");
  }
  const okAccess = {
    requirePermission: jest.fn().mockResolvedValue(undefined),
    teamRole: jest.fn().mockResolvedValue(Role.OWNER),
    requireProjectAccess: jest.fn().mockResolvedValue(undefined),
  };

  it("setIcon validates the PNG and persists the icon + marker", async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      project: { findUnique: jest.fn().mockResolvedValue({ id: "p1", teamId: "t1" }), update },
      projectIcon: { upsert },
      $transaction: jest.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    } as unknown as PrismaService;
    await make(prisma, okAccess).setIcon("u1", "p1", pngB64());
    expect(upsert).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { iconUpdatedAt: expect.any(Date) } }));
  });

  it("setIcon rejects a non-PNG payload", async () => {
    const prisma = { project: { findUnique: jest.fn().mockResolvedValue({ id: "p1", teamId: "t1" }) } } as unknown as PrismaService;
    await expect(make(prisma, okAccess).setIcon("u1", "p1", Buffer.from("not a png").toString("base64"))).rejects.toThrow(/PNG/);
  });

  it("getIcon 404s when the project has no icon", async () => {
    const prisma = {
      project: { findUnique: jest.fn().mockResolvedValue({ teamId: "t1" }) },
      projectIcon: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    await expect(make(prisma, okAccess).getIcon("u1", "p1")).rejects.toThrow(/no icon/);
  });

  it("deleteIcon is idempotent (deleteMany) and clears the marker", async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      project: { findUnique: jest.fn().mockResolvedValue({ id: "p1", teamId: "t1" }), update },
      projectIcon: { deleteMany },
      $transaction: jest.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    } as unknown as PrismaService;
    await make(prisma, okAccess).deleteIcon("u1", "p1");
    expect(deleteMany).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { iconUpdatedAt: null } }));
  });
});

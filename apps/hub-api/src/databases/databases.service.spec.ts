import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { DatabasesService } from "./databases.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { CryptoService } from "../crypto/crypto.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
} as unknown as CryptoService;

// OWNER/ADMIN hold every granular permission; VIEWER holds none.
const ALL_PERMS = [
  "apps:deploy",
  "apps:config",
  "databases",
  "backups",
  "servers:manage",
  "servers:ops",
  "terminal",
  "bulk",
  "monitors",
  "projects",
  "integrations",
  "variables",
];

// Permissive per-resource-scoping defaults so non-scoping tests stay green; overridden per test.
function accessWith(access: Partial<TeamAccessService>): TeamAccessService {
  return {
    requireResourceAccess: jest.fn().mockResolvedValue(undefined),
    grantResourceAccess: jest.fn().mockResolvedValue(undefined),
    membershipAccess: jest.fn().mockResolvedValue(null),
    accessByTeam: jest.fn().mockResolvedValue(new Map()),
    ...access,
  } as unknown as TeamAccessService;
}

function make(
  prisma: Partial<PrismaService>,
  access: Partial<TeamAccessService>,
  agentWs: Partial<AgentWsServer> = {},
  teamDefaults: { resolveDefaultEnvironmentId: jest.Mock } = {
    resolveDefaultEnvironmentId: jest.fn().mockResolvedValue("env-default"),
  },
) {
  return new DatabasesService(
    prisma as PrismaService,
    accessWith(access),
    audit,
    agentWs as AgentWsServer,
    crypto,
    teamDefaults as unknown as import("../teams/team-defaults.service").TeamDefaultsService,
  );
}

const db = {
  id: "db1",
  teamId: "t1",
  serverId: "s1",
  name: "main",
  engine: "POSTGRES",
  version: "16",
  image: "postgres:16",
  port: 5432,
  hostPort: null,
  credentials: `enc:${JSON.stringify({ username: "tugra", password: "pw", database: "main" })}`,
  status: "NEW",
  createdAt: new Date(),
};

describe("DatabasesService", () => {
  it("list() labels each database with its project/environment (batched, no N+1)", async () => {
    const envFindMany = jest.fn().mockResolvedValue([
      { id: "e1", name: "production", project: { id: "p1", name: "Default" } },
    ]);
    const prisma = {
      database: { findMany: jest.fn().mockResolvedValue([{ ...db, environmentId: "e1" }]) },
      environment: { findMany: envFindMany },
    } as unknown as PrismaService;
    const access = {
      accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: "OWNER", restrictedAccess: false, accessedProjects: [], accessedResources: [] }]])),
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(ALL_PERMS)]])),
    } as unknown as TeamAccessService;
    const out = await make(prisma, access).list("u1");
    expect(envFindMany).toHaveBeenCalledTimes(1);
    expect(out[0].projectName).toBe("Default");
    expect(out[0].environmentName).toBe("production");
  });

  describe("list(?q)", () => {
    const twoDbs = () => {
      const prisma = {
        database: {
          findMany: jest.fn().mockResolvedValue([
            { ...db, id: "db1", name: "main", engine: "POSTGRES", version: "16", environmentId: "e1" },
            { ...db, id: "db2", name: "cache", engine: "REDIS", version: "7", environmentId: "e1" },
          ]),
        },
        environment: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;
      const access = {
        accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: "OWNER", restrictedAccess: false, accessedProjects: [], accessedResources: [] }]])),
        permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(ALL_PERMS)]])),
      } as unknown as TeamAccessService;
      return make(prisma, access);
    };

    it("returns ALL databases when q is absent (non-breaking)", async () => {
      expect((await twoDbs().list("u1")).map((d) => d.name).sort()).toEqual(["cache", "main"]);
    });

    it("filters by name or engine (case-insensitive)", async () => {
      expect((await twoDbs().list("u1", "redis")).map((d) => d.name)).toEqual(["cache"]);
      expect((await twoDbs().list("u1", "MAIN")).map((d) => d.name)).toEqual(["main"]);
    });

    it("NEVER matches on secret fields — a query equal to the password returns nothing", async () => {
      // credentials carry password "pw"; it is decrypted into the view but must not be searchable.
      expect(await twoDbs().list("u1", "pw")).toEqual([]);
    });
  });

  it("forbids creating a database for a team the user can't write to", async () => {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    const svc = make(prisma, access);
    await expect(
      svc.create("u1", { name: "main", serverId: "s1", engine: "POSTGRES" }),
    ).rejects.toThrow(/nope/);
  });

  it("resolves to the team default environment when none is given (never orphan)", async () => {
    const create = jest.fn().mockResolvedValue({ ...db });
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      database: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue("OWNER"),
    } as unknown as TeamAccessService;
    const teamDefaults = { resolveDefaultEnvironmentId: jest.fn().mockResolvedValue("env-default") };
    await make(prisma, access, {}, teamDefaults).create("u1", { name: "main", serverId: "s1", engine: "POSTGRES" });
    expect(teamDefaults.resolveDefaultEnvironmentId).toHaveBeenCalledWith("t1");
    expect(create.mock.calls[0][0].data.environmentId).toBe("env-default");
  });

  describe("createForImport", () => {
    const setup = () => {
      const create = jest.fn().mockImplementation(({ data }) => ({ id: "dbi", createdAt: new Date(), ...data }));
      const prisma = {
        server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
        database: { create },
      } as unknown as PrismaService;
      const access = {
        requirePermission: jest.fn().mockResolvedValue(undefined),
        teamRole: jest.fn().mockResolvedValue("OWNER"),
      } as unknown as TeamAccessService;
      return { svc: make(prisma, access), create };
    };
    const input = {
      name: "orders", serverId: "s1", engine: "POSTGRES" as const,
      username: "app_user", password: "app_pw", database: "app_db",
    };

    it("persists CALLER-SUPPLIED credentials (not random) so the app's DATABASE_URL keeps working", async () => {
      const { svc, create } = setup();
      const view = await svc.createForImport("u1", input);
      // the writer view decrypts the stored credentials — they are exactly what was supplied
      expect(view.username).toBe("app_user");
      expect(view.password).toBe("app_pw");
      expect(view.database).toBe("app_db");
      expect(create.mock.calls[0][0].data.credentials).toBe(
        `enc:${JSON.stringify({ username: "app_user", password: "app_pw", database: "app_db" })}`,
      );
    });

    it("keeps a custom image when supplied, and defaults to the resolved engine image otherwise", async () => {
      const { svc, create } = setup();
      await svc.createForImport("u1", { ...input, image: "pgvector/pgvector:pg16" });
      expect(create.mock.calls[0][0].data.image).toBe("pgvector/pgvector:pg16");

      const { svc: svc2, create: create2 } = setup();
      await svc2.createForImport("u1", input); // no image
      expect(create2.mock.calls[0][0].data.image).toMatch(/postgres/);
    });

    it("rejects an image reference with shell metacharacters (injection guard)", async () => {
      const { svc, create } = setup();
      await expect(
        svc.createForImport("u1", { ...input, image: "postgres:16; rm -rf /" }),
      ).rejects.toThrow(BadRequestException);
      expect(create).not.toHaveBeenCalled();
    });

    it("accepts a private-registry image with a host:port", async () => {
      const { svc, create } = setup();
      await svc.createForImport("u1", { ...input, image: "registry.internal:5000/pg:16" });
      expect(create.mock.calls[0][0].data.image).toBe("registry.internal:5000/pg:16");
    });

    it("rejects an unsafe database name or username (ClickHouse-injection guard)", async () => {
      const { svc, create } = setup();
      await expect(svc.createForImport("u1", { ...input, database: 'x" ; SELECT 1' })).rejects.toThrow(BadRequestException);
      await expect(svc.createForImport("u1", { ...input, username: "u`whoami`" })).rejects.toThrow(BadRequestException);
      expect(create).not.toHaveBeenCalled();
    });

    it("requires apps:config (not just databases) for a custom image", async () => {
      const create = jest.fn();
      const prisma = {
        server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
        database: { create },
      } as unknown as PrismaService;
      const access = {
        requirePermission: jest.fn().mockImplementation((_u: string, _t: string, perm: string) =>
          perm === "apps:config" ? Promise.reject(new ForbiddenException("no apps:config")) : Promise.resolve(undefined),
        ),
        teamRole: jest.fn().mockResolvedValue("OWNER"),
      } as unknown as TeamAccessService;
      await expect(
        make(prisma, access).createForImport("u1", { ...input, image: "pgvector/pgvector:pg16" }),
      ).rejects.toThrow(/no apps:config/);
      expect(create).not.toHaveBeenCalled();
    });

    it("still enforces the databases permission", async () => {
      const prisma = {
        server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
      await expect(make(prisma, access).createForImport("u1", input)).rejects.toThrow(/nope/);
    });
  });

  it("uses the chosen environment and validates it, without resolving a default", async () => {
    const create = jest.fn().mockResolvedValue({ ...db });
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e1", project: { teamId: "t1" } }) },
      database: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue("OWNER"),
    } as unknown as TeamAccessService;
    const teamDefaults = { resolveDefaultEnvironmentId: jest.fn() };
    await make(prisma, access, {}, teamDefaults).create("u1", {
      name: "main",
      serverId: "s1",
      engine: "POSTGRES",
      environmentId: "e1",
    });
    expect(teamDefaults.resolveDefaultEnvironmentId).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].data.environmentId).toBe("e1");
  });

  it("provisions via the agent and records RUNNING on exit 0", async () => {
    const update = jest.fn().mockResolvedValue({ ...db, status: "RUNNING" });
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db), update },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue("OWNER"),
    } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "Up" }),
    } as unknown as AgentWsServer;

    const svc = make(prisma, access, agentWs);
    const view = await svc.provision("u1", "db1");

    expect(agentWs.sendCommand).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "RUNNING" } }),
    );
    expect(view.status).toBe("RUNNING");
    // owner (write) sees the connection details
    expect(view.connectionUri).toContain("postgresql://tugra:pw@tugra_db_db1:5432/main");
  });

  it("normalizes and stores tags on setTags", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access).setTags("u1", "db1", ["Prod", "prod", " cache "]);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { tags: ["cache", "prod"] } }),
    );
  });

  it("forbids a non-writer from setting resource limits", async () => {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    await expect(make(prisma, access).setLimits("u1", "db1", { memoryMb: 512 })).rejects.toThrow(/nope/);
  });

  it("persists resource limits + health-check for a writer", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access).setLimits("u1", "db1", { healthCmd: "pg_isready", memoryMb: 512, cpus: 1 });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { healthCmd: "pg_isready", memoryMb: 512, cpus: 1 } }),
    );
  });

  it("renames a database for a writer", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access).rename("u1", "db1", "renamed");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: "renamed" } }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.name.update" }));
  });

  it("forbids a non-writer from changing the public port", async () => {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    await expect(make(prisma, access).setPort("u1", "db1", 15432)).rejects.toThrow(/nope/);
  });

  it("sets and clears the public host port for a writer", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access);
    await svc.setPort("u1", "db1", 15432);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { hostPort: 15432 } }));
    await svc.setPort("u1", "db1", null);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { hostPort: null } }));
  });

  it("hides connection details from non-write (viewer) members", async () => {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
      // canWrite derives from the member's effective 'databases' permission (a VIEWER holds none).
      membership: { findUnique: jest.fn().mockResolvedValue({ role: "VIEWER", teamRole: null }) },
    } as unknown as PrismaService;
    const access = {
      teamRole: jest.fn().mockResolvedValue("VIEWER"),
    } as unknown as TeamAccessService;
    const svc = make(prisma, access);
    const view = await svc.get("u1", "db1");
    expect(view.canWrite).toBe(false);
    expect(view.connectionUri).toBeNull();
    expect(view.password).toBeNull();
  });
});

import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
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
  logStream: { stream: jest.Mock } = { stream: jest.fn() },
  containerMetricsSvc: { forApp: jest.Mock } = { forApp: jest.fn() },
) {
  return new DatabasesService(
    prisma as PrismaService,
    accessWith(access),
    audit,
    agentWs as AgentWsServer,
    logStream as unknown as import("../agent-gateway/log-stream.service").LogStreamService,
    containerMetricsSvc as unknown as import("../metrics/container-metrics.service").ContainerMetricsService,
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

  it("streamLogs follows this db's own container (writer-only) and audits", async () => {
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = { isOnline: jest.fn().mockReturnValue(true) } as unknown as AgentWsServer;
    const observable = { pipe: jest.fn() } as never;
    const logStream = { stream: jest.fn().mockReturnValue(observable) };
    (audit.log as jest.Mock).mockClear();

    const result = await make(prisma, access, agentWs, undefined, logStream).streamLogs("u1", "db1", { tail: 50 });

    // Target is server-derived (tugra_db_<id>) — never from the client, so nothing to inject.
    expect(logStream.stream).toHaveBeenCalledWith("s1", "tugra_db_db1", expect.objectContaining({ follow: true }));
    expect(result).toBe(observable);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.logs.stream", target: "db1" }));
  });

  it("streamLogs rejects when the agent is offline (no stream started)", async () => {
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = { isOnline: jest.fn().mockReturnValue(false) } as unknown as AgentWsServer;
    const logStream = { stream: jest.fn() };

    await expect(make(prisma, access, agentWs, undefined, logStream).streamLogs("u1", "db1", {})).rejects.toThrow();
    expect(logStream.stream).not.toHaveBeenCalled();
  });

  it("streamLogs rejects a non-writer (databases permission required)", async () => {
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException()) } as unknown as TeamAccessService;
    const agentWs = { isOnline: jest.fn().mockReturnValue(true) } as unknown as AgentWsServer;
    const logStream = { stream: jest.fn() };

    await expect(
      make(prisma, access, agentWs, undefined, logStream).streamLogs("u1", "db1", {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(logStream.stream).not.toHaveBeenCalled();
  });

  it("downloadLogs runs docker logs against this db's container and audits", async () => {
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "log-text" }),
    } as unknown as AgentWsServer;
    (audit.log as jest.Mock).mockClear();

    const out = await make(prisma, access, agentWs).downloadLogs("u1", "db1", { tail: 100 });

    expect(agentWs.sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("tugra_db_db1"), "database", expect.any(Number));
    expect(out).toBe("log-text");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.logs.download", target: "db1" }));
  });

  it("containerMetrics queries this db's container by its deterministic name prefix (read-level)", async () => {
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db) } } as unknown as PrismaService;
    // read-level: require() needs team membership + per-resource access, not the write permission
    const access = {
      teamRole: jest.fn().mockResolvedValue("OWNER"),
      requireResourceAccess: jest.fn().mockResolvedValue(undefined),
    } as unknown as TeamAccessService;
    const metrics = { forApp: jest.fn().mockResolvedValue({ containers: [] }) };

    const out = await make(prisma, access, {}, undefined, undefined, metrics).containerMetrics("u1", "db1", "1h");

    expect(metrics.forApp).toHaveBeenCalledWith("s1", "tugra_db_db1", "1h");
    expect(out).toEqual({ containers: [] });
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

describe("DatabasesService - custom icon", () => {
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
  const dbRow = { id: "db1", teamId: "t1", environmentId: "e1" };
  const okAccess = {
    teamRole: jest.fn().mockResolvedValue(Role.OWNER),
    requirePermission: jest.fn().mockResolvedValue(undefined),
    requireResourceAccess: jest.fn().mockResolvedValue(undefined),
  };

  it("setIcon validates the PNG and persists the icon + marker", async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(dbRow), update },
      databaseIcon: { upsert },
      $transaction: jest.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    } as unknown as PrismaService;
    await make(prisma, okAccess).setIcon("u1", "db1", pngB64());
    expect(upsert).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { iconUpdatedAt: expect.any(Date) } }));
  });

  it("setIcon rejects a non-PNG payload", async () => {
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(dbRow) } } as unknown as PrismaService;
    await expect(make(prisma, okAccess).setIcon("u1", "db1", Buffer.from("not a png").toString("base64"))).rejects.toThrow(/PNG/);
  });

  it("getIcon 404s when the database has no icon", async () => {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(dbRow) },
      databaseIcon: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    await expect(make(prisma, okAccess).getIcon("u1", "db1")).rejects.toThrow(/no icon/);
  });

  it("deleteIcon is idempotent and clears the marker", async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(dbRow), update },
      databaseIcon: { deleteMany },
      $transaction: jest.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    } as unknown as PrismaService;
    await make(prisma, okAccess).deleteIcon("u1", "db1");
    expect(deleteMany).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { iconUpdatedAt: null } }));
  });

  describe("clone", () => {
    const src = {
      id: "db1",
      teamId: "t1",
      serverId: "s1",
      environmentId: "e1",
      name: "main",
      engine: "POSTGRES",
      version: "16",
      image: "postgres:16",
      port: 5432,
      hostPort: 5433,
      credentials: `enc:${JSON.stringify({ username: "tugra", password: "secret-source-pw", database: "main" })}`,
      status: "RUNNING",
      healthCmd: "pg_isready",
      memoryMb: 512,
      cpus: 1.5,
      tags: ["prod", "eu"],
      envEnc: `enc:${JSON.stringify({ TZ: "Europe/Istanbul" })}`,
      volumes: [{ name: "cache", path: "/cache" }],
    };

    function cloneSetup(srcRow: Record<string, unknown>, access: Partial<TeamAccessService> = {}) {
      const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({ ...data, id: "db-clone" }));
      const grantResourceAccess = jest.fn().mockResolvedValue(undefined);
      const prisma = { database: { findUnique: jest.fn().mockResolvedValue(srcRow), create } } as unknown as PrismaService;
      const svc = make(prisma, {
        requirePermission: jest.fn().mockResolvedValue(undefined),
        teamRole: jest.fn().mockResolvedValue("OWNER"),
        grantResourceAccess,
        ...access,
      });
      return { svc, create, grantResourceAccess };
    }

    it("copies config (never data): engine/version/image/port/limits/health/tags carried, host port and status reset", async () => {
      const { svc, create, grantResourceAccess } = cloneSetup(src);
      (audit.log as jest.Mock).mockClear();

      const out = await svc.clone("u1", "db1", {});

      const data = create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        engine: "POSTGRES",
        version: "16",
        image: "postgres:16",
        port: 5432,
        healthCmd: "pg_isready",
        memoryMb: 512,
        cpus: 1.5,
        tags: ["prod", "eu"],
        teamId: "t1",
        serverId: "s1",
        environmentId: "e1",
        envEnc: `enc:${JSON.stringify({ TZ: "Europe/Istanbul" })}`, // user env is config → carried
        volumes: [{ name: "cache", path: "/cache" }], // volume definitions are config → carried (fresh empty volume via new id)
      });
      // Collision-prone + runtime state are reset, not copied.
      expect(data.hostPort).toBeNull();
      expect(data.status).toBe("NEW");
      expect(data.name).toBe("main (copy)");
      // Grant-on-create keeps the cloner's access to the new resource.
      expect(grantResourceAccess).toHaveBeenCalledWith("u1", "t1", "db-clone");
      // Flat response (view fields at top level, not nested under a `database` key) so the secret-redaction
      // interceptor, which only nulls top-level fields, masks the clone's credentials for scope-limited PATs.
      expect(out.id).toBe("db-clone");
      expect(typeof out.database).toBe("string"); // the view's db-name field, not a nested view object
      expect(out.warnings).toEqual(["data_not_copied", "host_port_reset"]);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "database.clone", target: "db-clone", meta: { from: "db1" } }),
      );
    });

    it("mints fresh credentials — never reuses the source password", async () => {
      const { svc, create } = cloneSetup(src);
      await svc.clone("u1", "db1", {});
      const creds = JSON.parse((create.mock.calls[0][0].data.credentials as string).replace(/^enc:/, ""));
      expect(creds.username).toBe("tugra");
      expect(creds.password).not.toBe("secret-source-pw");
      expect(creds.password.length).toBeGreaterThan(20);
    });

    it("omits host_port_reset when the source has no external port", async () => {
      const { svc } = cloneSetup({ ...src, hostPort: null });
      const out = await svc.clone("u1", "db1", {});
      expect(out.warnings).toEqual(["data_not_copied"]);
    });

    it("keeps the (copy) suffix for a long source name, within the 60-char cap", async () => {
      const longName = "x".repeat(70);
      const { svc, create } = cloneSetup({ ...src, name: longName });
      await svc.clone("u1", "db1", {});
      const cloneName = create.mock.calls[0][0].data.name as string;
      expect(cloneName.endsWith(" (copy)")).toBe(true);
      expect(cloneName.length).toBeLessThanOrEqual(60);
    });

    it("honors a custom name (clamped) and validates a target environment in the same team", async () => {
      const assertEnv = jest.spyOn(DatabasesService.prototype as unknown as { assertEnvInTeam: () => Promise<void> }, "assertEnvInTeam").mockResolvedValue(undefined);
      const { svc, create } = cloneSetup(src);
      await svc.clone("u1", "db1", { name: "  staging copy  ", environmentId: "e2" });
      expect(assertEnv).toHaveBeenCalledWith("e2", "t1");
      const data = create.mock.calls[0][0].data;
      expect(data.name).toBe("staging copy");
      expect(data.environmentId).toBe("e2");
      assertEnv.mockRestore();
    });

    it("rejects a non-writer (databases permission gate on the source)", async () => {
      const { svc } = cloneSetup(src, { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException()) });
      await expect(svc.clone("u1", "db1", {})).rejects.toThrow();
    });
  });

  describe("env vars", () => {
    const envRow = { id: "db1", teamId: "t1", engine: "POSTGRES", envEnc: `enc:${JSON.stringify({ TZ: "UTC", PGDATA: "/data" })}` };
    const okWrite = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;

    it("getEnv decrypts the stored vars (writer-only)", async () => {
      const prisma = { database: { findUnique: jest.fn().mockResolvedValue(envRow) } } as unknown as PrismaService;
      const out = await make(prisma, okWrite).getEnv("u1", "db1");
      expect(out).toEqual({ TZ: "UTC", PGDATA: "/data" });
    });

    it("getEnv returns {} when none are set", async () => {
      const prisma = { database: { findUnique: jest.fn().mockResolvedValue({ ...envRow, envEnc: null }) } } as unknown as PrismaService;
      expect(await make(prisma, okWrite).getEnv("u1", "db1")).toEqual({});
    });

    it("getEnv rejects a non-writer (databases permission required)", async () => {
      const prisma = { database: { findUnique: jest.fn().mockResolvedValue(envRow) } } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException()) } as unknown as TeamAccessService;
      await expect(make(prisma, access).getEnv("u1", "db1")).rejects.toThrow();
    });

    it("setEnv encrypts the whole blob and audits", async () => {
      const update = jest.fn().mockResolvedValue({});
      const prisma = { database: { findUnique: jest.fn().mockResolvedValue(envRow), update } } as unknown as PrismaService;
      (audit.log as jest.Mock).mockClear();
      await make(prisma, okWrite).setEnv("u1", "db1", { TZ: "Europe/Istanbul" });
      expect(update).toHaveBeenCalledWith({ where: { id: "db1" }, data: { envEnc: `enc:${JSON.stringify({ TZ: "Europe/Istanbul" })}` } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.env.update", target: "db1" }));
    });

    it("setEnv rejects a reserved engine credential key (no shadowing managed credentials)", async () => {
      const update = jest.fn();
      const prisma = { database: { findUnique: jest.fn().mockResolvedValue(envRow), update } } as unknown as PrismaService;
      await expect(make(prisma, okWrite).setEnv("u1", "db1", { POSTGRES_PASSWORD: "hijack" })).rejects.toThrow(/reserved/);
      expect(update).not.toHaveBeenCalled();
    });

    it("setEnv rejects an auth-subverting var that is not a literal credential key", async () => {
      const update = jest.fn();
      const prisma = { database: { findUnique: jest.fn().mockResolvedValue(envRow), update } } as unknown as PrismaService;
      // POSTGRES_HOST_AUTH_METHOD=trust would disable password auth on a published port — must be refused.
      await expect(make(prisma, okWrite).setEnv("u1", "db1", { POSTGRES_HOST_AUTH_METHOD: "trust" })).rejects.toThrow(/reserved/);
      // *_FILE / random-password overrides are refused for the engine that honours them.
      const mysqlRow = { ...envRow, engine: "MYSQL" };
      const mysqlPrisma = { database: { findUnique: jest.fn().mockResolvedValue(mysqlRow), update } } as unknown as PrismaService;
      await expect(make(mysqlPrisma, okWrite).setEnv("u1", "db1", { MYSQL_RANDOM_ROOT_PASSWORD: "1" })).rejects.toThrow(/reserved/);
      expect(update).not.toHaveBeenCalled();
    });

    it("setEnv accepts a legitimate non-credential var (TZ)", async () => {
      const update = jest.fn().mockResolvedValue({});
      const prisma = { database: { findUnique: jest.fn().mockResolvedValue(envRow), update } } as unknown as PrismaService;
      await make(prisma, okWrite).setEnv("u1", "db1", { TZ: "UTC", PGDATA: "/data" });
      expect(update).toHaveBeenCalled();
    });
  });

  describe("moveToServer", () => {
    const okWrite = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const srcRow = { id: "db1", teamId: "t1", serverId: "s1", status: "NEW", hostPort: 5433 };

    it("moves a NEW database to another same-team server (atomic NEW+server guard) and resets the host port", async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const prisma = {
        database: { findUnique: jest.fn().mockResolvedValue(srcRow), updateMany },
        server: { findUnique: jest.fn().mockResolvedValue({ id: "s2", teamId: "t1" }) },
      } as unknown as PrismaService;
      (audit.log as jest.Mock).mockClear();
      await make(prisma, okWrite).moveToServer("u1", "db1", "s2");
      expect(updateMany).toHaveBeenCalledWith({ where: { id: "db1", status: "NEW", serverId: "s1" }, data: { serverId: "s2", hostPort: null } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.server.update", target: "db1", meta: { to: "s2" } }));
    });

    it("refuses a move that raced a deploy (atomic update matched nothing → count 0)", async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 0 }); // provision flipped it to PROVISIONING
      const prisma = {
        database: { findUnique: jest.fn().mockResolvedValue(srcRow), updateMany },
        server: { findUnique: jest.fn().mockResolvedValue({ id: "s2", teamId: "t1" }) },
      } as unknown as PrismaService;
      await expect(make(prisma, okWrite).moveToServer("u1", "db1", "s2")).rejects.toThrow(/started deploying while being moved/);
    });

    it("refuses to move a provisioned (non-NEW) database — data can't cross servers", async () => {
      const updateMany = jest.fn();
      const prisma = {
        database: { findUnique: jest.fn().mockResolvedValue({ ...srcRow, status: "RUNNING" }), updateMany },
        server: { findUnique: jest.fn().mockResolvedValue({ id: "s2", teamId: "t1" }) },
      } as unknown as PrismaService;
      await expect(make(prisma, okWrite).moveToServer("u1", "db1", "s2")).rejects.toThrow(/hasn't been deployed|back this one up/);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it("refuses a target server in another team", async () => {
      const updateMany = jest.fn();
      const prisma = {
        database: { findUnique: jest.fn().mockResolvedValue(srcRow), updateMany },
        server: { findUnique: jest.fn().mockResolvedValue({ id: "s2", teamId: "t2" }) },
      } as unknown as PrismaService;
      await expect(make(prisma, okWrite).moveToServer("u1", "db1", "s2")).rejects.toBeInstanceOf(ForbiddenException);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it("is a no-op when the target is the current server (no server lookup, no write)", async () => {
      const updateMany = jest.fn();
      const findServer = jest.fn();
      const prisma = {
        database: { findUnique: jest.fn().mockResolvedValue({ ...srcRow, status: "RUNNING" }), updateMany },
        server: { findUnique: findServer },
      } as unknown as PrismaService;
      await make(prisma, okWrite).moveToServer("u1", "db1", "s1");
      expect(findServer).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    });

    it("rejects a non-writer (databases permission required)", async () => {
      const prisma = { database: { findUnique: jest.fn().mockResolvedValue(srcRow) } } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException()) } as unknown as TeamAccessService;
      await expect(make(prisma, access).moveToServer("u1", "db1", "s2")).rejects.toThrow();
    });
  });

  describe("volumes", () => {
    const volRow = { id: "db1", teamId: "t1", engine: "POSTGRES" };
    const okWrite = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;

    it("setVolumes persists the list and audits (writer-only)", async () => {
      const update = jest.fn().mockResolvedValue({});
      const prisma = { database: { findUnique: jest.fn().mockResolvedValue(volRow), update } } as unknown as PrismaService;
      (audit.log as jest.Mock).mockClear();
      await make(prisma, okWrite).setVolumes("u1", "db1", [{ name: "cache", path: "/cache" }]);
      expect(update).toHaveBeenCalledWith({ where: { id: "db1" }, data: { volumes: [{ name: "cache", path: "/cache" }] } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.volumes.update", target: "db1" }));
    });

    it("setVolumes rejects a mount that overlaps the managed data dir (exact / under / over)", async () => {
      const update = jest.fn();
      const prisma = { database: { findUnique: jest.fn().mockResolvedValue(volRow), update } } as unknown as PrismaService;
      const svc = () => make(prisma, okWrite);
      // exact — shadows the managed data volume
      await expect(svc().setVolumes("u1", "db1", [{ name: "x", path: "/var/lib/postgresql/data" }])).rejects.toThrow(/overlaps the managed data volume/);
      // nested UNDER — leaves the data dir non-empty before init (corrupts initdb)
      await expect(svc().setVolumes("u1", "db1", [{ name: "x", path: "/var/lib/postgresql/data/pgdata" }])).rejects.toThrow(/overlaps the managed data volume/);
      // ancestor OVER — would hide the managed mount's siblings
      await expect(svc().setVolumes("u1", "db1", [{ name: "x", path: "/var/lib" }])).rejects.toThrow(/overlaps the managed data volume/);
      expect(update).not.toHaveBeenCalled();
    });

    it("setVolumes rejects a non-writer (databases permission required)", async () => {
      const prisma = { database: { findUnique: jest.fn().mockResolvedValue(volRow) } } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException()) } as unknown as TeamAccessService;
      await expect(make(prisma, access).setVolumes("u1", "db1", [])).rejects.toThrow();
    });
  });
});

import { BadRequestException } from "@nestjs/common";
import { DatabasesService } from "./databases.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { CryptoService } from "../crypto/crypto.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const crypto = { encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, "") } as unknown as CryptoService;

const row = (over: Record<string, unknown> = {}) => ({
  id: "db1",
  teamId: "t1",
  serverId: "s1",
  environmentId: "env1",
  name: "main",
  engine: "POSTGRES",
  version: "16",
  image: "postgres:16",
  port: 5432,
  hostPort: null,
  credentials: `enc:${JSON.stringify({ username: "tugra", password: "pw", database: "main" })}`,
  envEnc: null,
  volumes: null,
  healthCmd: null,
  memoryMb: null,
  cpus: null,
  tags: [],
  status: "NEW",
  pitrEnabled: false,
  ssl: false,
  pgParentMount: false,
  createdAt: new Date(),
  ...over,
});

function make(db: Record<string, unknown>) {
  const update = jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ ...db, ...args.data }));
  const create = jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "new1", ...args.data }));
  const prisma = {
    database: { findUnique: jest.fn().mockResolvedValue(db), update, create },
    server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
    environment: { findFirst: jest.fn().mockResolvedValue({ id: "env1" }), findUnique: jest.fn().mockResolvedValue(null) },
    membership: { findUnique: jest.fn().mockResolvedValue({ role: "OWNER", teamRole: null }) },
  } as unknown as PrismaService;
  const access = {
    requirePermission: jest.fn().mockResolvedValue(undefined),
    teamRole: jest.fn().mockResolvedValue("OWNER"),
    requireResourceAccess: jest.fn().mockResolvedValue(undefined),
    grantResourceAccess: jest.fn().mockResolvedValue(undefined),
    permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["databases"])]])),
  } as unknown as TeamAccessService;
  const sendCommand = jest.fn().mockResolvedValue({ output: "Up 1s", exitCode: 0 });
  const svc = new DatabasesService(
    prisma,
    access,
    audit,
    { sendCommand } as unknown as AgentWsServer,
    { stream: jest.fn() } as unknown as import("../agent-gateway/log-stream.service").LogStreamService,
    { forApp: jest.fn() } as unknown as import("../metrics/container-metrics.service").ContainerMetricsService,
    crypto,
    { resolveDefaultEnvironmentId: jest.fn().mockResolvedValue("env1") } as unknown as import("../teams/team-defaults.service").TeamDefaultsService,
  );
  return { svc, sendCommand, update, create };
}

const runScript = (sendCommand: jest.Mock) => String(sendCommand.mock.calls[0][1]);
const mountOf = (s: string) => /-v tugra_dbv_\S+:(\S+)/.exec(s)?.[1];

describe("DatabasesService: the PostgreSQL data layout", () => {
  it("a NEW PostgreSQL 18 database is created with the parent mount; 16 and 17 and other engines are not", async () => {
    for (const [version, flagged] of [["16", false], ["17", false], ["18", true], ["19", true]] as const) {
      const { svc, create } = make(row());
      await svc.createForImport("u1", { name: "x", serverId: "s1", engine: "POSTGRES", version, username: "u", password: "p", database: "d" });
      const data = create.mock.calls[0][0].data;
      expect(data.pgParentMount === true).toBe(flagged);
    }
    const { svc, create } = make(row());
    await svc.createForImport("u1", { name: "x", serverId: "s1", engine: "MYSQL", version: "8", username: "u", password: "p", database: "d" });
    expect(create.mock.calls[0][0].data).not.toHaveProperty("pgParentMount");
  });

  it("provisioning a PostgreSQL 18 database that has the parent mount mounts /var/lib/postgresql", async () => {
    const { svc, sendCommand } = make(row({ version: "18", image: "postgres:18", pgParentMount: true }));
    await svc.provision("u1", "db1");
    const s = runScript(sendCommand);
    expect(mountOf(s)).toBe("/var/lib/postgresql");
    expect(s).not.toContain("PGANON");
  });

  it("a never-started PostgreSQL 18 row of an older hub is switched to the parent mount when it is provisioned", async () => {
    const { svc, sendCommand, update } = make(row({ version: "18", image: "postgres:18-alpine", pgParentMount: false, status: "NEW" }));
    await svc.provision("u1", "db1");
    expect(mountOf(runScript(sendCommand))).toBe("/var/lib/postgresql");
    expect(update.mock.calls[0][0].data).toMatchObject({ status: "PROVISIONING", pgParentMount: true });
  });

  it("a PostgreSQL 18 database that already ran under the old mount keeps its mount and re-attaches its anonymous volume on recreate", async () => {
    const { svc, sendCommand, update } = make(row({ version: "18", image: "postgres:18", pgParentMount: false, status: "RUNNING" }));
    await svc.provision("u1", "db1");
    const s = runScript(sendCommand);
    expect(mountOf(s)).toBe("/var/lib/postgresql/data");
    expect(s).toContain("PGANON=$(docker inspect");
    expect(s.indexOf("PGANON=$(")).toBeLessThan(s.indexOf("docker rm -f tugra_db_db1"));
    expect(s).toContain("${PGANON:+-v ${PGANON}:/var/lib/postgresql}");
    for (const c of update.mock.calls) expect(c[0].data).not.toHaveProperty("pgParentMount");
  });

  it("a custom postgres:18 image (default version 16), a floating tag and a postgis image are created with the parent mount", async () => {
    const cases: Array<[string | undefined, string | undefined, boolean]> = [
      [undefined, "postgres:18", true],
      ["16", "postgres:18-alpine", true],
      [undefined, "postgres:latest", true],
      [undefined, "postgres:alpine", true],
      ["latest", undefined, true],
      ["alpine", undefined, true],
      [undefined, "postgis/postgis:18-3.6", true],
      [undefined, "postgres:17", false],
      [undefined, "custom/img:1", false],
    ];
    for (const [version, image, flagged] of cases) {
      const { svc, create } = make(row());
      await svc.createForImport("u1", { name: "x", serverId: "s1", engine: "POSTGRES", ...(version ? { version } : {}), ...(image ? { image } : {}), username: "u", password: "p", database: "d" });
      expect(`${image ?? version}:${create.mock.calls[0][0].data.pgParentMount === true}`).toBe(`${image ?? version}:${flagged}`);
    }
  });

  it("a started row whose image is postgres:18 but whose version says 16 is flagged and keeps its mount", async () => {
    const { svc, sendCommand } = make(row({ version: "16", image: "postgres:18", status: "RUNNING" }));
    expect((await svc.get("u1", "db1")).dataLayoutWarning).toBe("pg_anonymous_volume");
    await svc.provision("u1", "db1");
    const s = runScript(sendCommand);
    expect(mountOf(s)).toBe("/var/lib/postgresql/data");
    expect(s).toContain("PGANON=$(docker inspect");
  });

  it("a FAILED PostgreSQL 18 row whose container does not exist moves to the parent mount at its next provision", async () => {
    const { svc, sendCommand, update } = make(row({ version: "18", image: "postgres:18", pgParentMount: false, status: "FAILED" }));
    sendCommand.mockImplementation((_s: string, script: string) =>
      Promise.resolve(script.includes("docker inspect -f '{{.Id}}'") && !script.includes("docker run") ? { output: "tugra-container-absent\n", exitCode: 0 } : { output: "Up 1s", exitCode: 0 }),
    );
    await svc.provision("u1", "db1");
    const run = sendCommand.mock.calls.map((c) => String(c[1])).find((s) => s.includes("docker run"))!;
    expect(mountOf(run)).toBe("/var/lib/postgresql");
    expect(run).not.toContain("PGANON");
    expect(update.mock.calls[0][0].data).toMatchObject({ status: "PROVISIONING", pgParentMount: true });
  });

  it("a FAILED row whose container still exists, or whose host cannot be asked, keeps the old mount (the cluster may be in its anonymous volume)", async () => {
    for (const probe of [() => Promise.resolve({ output: "tugra-container-present\n", exitCode: 0 }), () => Promise.reject(new Error("agent offline")), () => Promise.resolve({ output: "boom", exitCode: 1 })]) {
      const { svc, sendCommand, update } = make(row({ version: "18", image: "postgres:18", pgParentMount: false, status: "FAILED" }));
      sendCommand.mockImplementation((_s: string, script: string) => (script.includes("docker run") ? Promise.resolve({ output: "Up", exitCode: 0 }) : probe()));
      await svc.provision("u1", "db1");
      const run = sendCommand.mock.calls.map((c) => String(c[1])).find((s) => s.includes("docker run"))!;
      expect(mountOf(run)).toBe("/var/lib/postgresql/data");
      for (const c of update.mock.calls) expect(c[0].data).not.toHaveProperty("pgParentMount");
    }
  });

  it("the view does not warn about a FAILED PostgreSQL 18 row (no cluster is known to exist)", async () => {
    const { svc } = make(row({ version: "18", image: "postgres:18", status: "FAILED" }));
    expect((await svc.get("u1", "db1")).dataLayoutWarning).toBeNull();
  });

  it("PostgreSQL 16 and 17 databases keep the original mount and a script without any layout lines", async () => {
    for (const v of ["16", "17"]) {
      const { svc, sendCommand } = make(row({ version: v, image: `postgres:${v}`, status: "RUNNING" }));
      await svc.provision("u1", "db1");
      const s = runScript(sendCommand);
      expect(mountOf(s)).toBe("/var/lib/postgresql/data");
      expect(s).not.toContain("PGANON");
    }
  });

  it("the view warns about a started PostgreSQL 18 database in the old layout and about nothing else", async () => {
    const warn = async (over: Record<string, unknown>) => {
      const { svc } = make(row(over));
      return (await svc.get("u1", "db1")).dataLayoutWarning;
    };
    expect(await warn({ version: "18", image: "postgres:18", status: "RUNNING" })).toBe("pg_anonymous_volume");
    expect(await warn({ version: "18", image: "postgres:18", status: "RUNNING", pgParentMount: true })).toBeNull();
    expect(await warn({ version: "18", image: "postgres:18", status: "NEW" })).toBeNull();
    expect(await warn({ version: "17", image: "postgres:17", status: "RUNNING" })).toBeNull();
    expect(await warn({ engine: "MYSQL", version: "8", image: "mysql:8", status: "RUNNING" })).toBeNull();
  });

  it("an extra volume may not overlap the mount the database actually uses (the parent for PostgreSQL 18)", async () => {
    const parent = make(row({ version: "18", image: "postgres:18", pgParentMount: true }));
    await expect(parent.svc.setVolumes("u1", "db1", [{ name: "x", path: "/var/lib/postgresql/18/docker" }])).rejects.toThrow(BadRequestException);
    await expect(parent.svc.setVolumes("u1", "db1", [{ name: "x", path: "/var/lib/postgresql/data" }])).rejects.toThrow(/overlaps the managed data volume \(\/var\/lib\/postgresql\)/);
    const old = make(row({ version: "16", image: "postgres:16" }));
    await expect(old.svc.setVolumes("u1", "db1", [{ name: "x", path: "/var/lib/postgresql/data" }])).rejects.toThrow(/\(\/var\/lib\/postgresql\/data\)/);
  });

  it("a clone of a PostgreSQL 18 database is a new empty volume with the parent mount, even from an old-layout source", async () => {
    const { svc, create } = make(row({ version: "18", image: "postgres:18", status: "RUNNING", pgParentMount: false }));
    await svc.clone("u1", "db1", {});
    expect(create.mock.calls[0][0].data).toMatchObject({ pgParentMount: true });
  });
});

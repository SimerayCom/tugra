import { InFlightService, TAKEOVER_ACTIVE, CLEANUP_ACTIVE, VOLUME_TRANSFER_ACTIVE, OBJECT_MIGRATION_ACTIVE, PROJECT_MOVE_ACTIVE, CLEANUP_STALE_MS, CUTOVER_ALIVE_MS, DEPLOYMENT_ACTIVE, ROLLOUT_ACTIVE, REBOOT_ACTIVE, SWARM_BUSY, ORPHAN_MS } from "./in-flight.service";
import { InFlightRegistry } from "./in-flight.registry";
import { TERMINAL_RUN_STATUSES } from "../migration-runs/core/run-contract";
import type { PrismaService } from "../prisma/prisma.service";

const T0 = new Date("2026-11-27T10:00:00.000Z");
const T1 = new Date("2026-11-27T10:05:00.000Z");

// A fixed clock: the service drops rows older than a runner can last, and the fixtures are dated around T0.
beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(new Date("2026-11-27T10:10:00.000Z").getTime()));
afterEach(() => jest.restoreAllMocks());

type Rows = Partial<
  Record<
    | "run" | "takeover" | "cleanup" | "cutover" | "cutoverDomain" | "projectMove" | "appMove" | "transfer" | "object" | "server"
    | "import" | "bulk" | "deployment" | "backup" | "baseBackup" | "volumeBackup" | "hubBackup" | "restore" | "drill" | "rollout" | "audit" | "cluster" | "reboot" | "database",
    unknown[]
  >
>;

/** A prisma stub whose findMany applies the status filter the service asked for, so the spec checks the query AND the filtering. */
function make(rows: Rows) {
  const inList = (v: unknown): string[] | null => (v && typeof v === "object" && "in" in v ? ((v as { in: string[] }).in) : null);
  const notInList = (v: unknown): string[] | null => (v && typeof v === "object" && "notIn" in v ? ((v as { notIn: string[] }).notIn) : null);
  const fm = (key: keyof Rows, field: string) =>
    jest.fn(async (args: { where?: Record<string, unknown> }) => {
      const all = (rows[key] ?? []) as Record<string, unknown>[];
      const w = args?.where ?? {};
      return all.filter((r) => {
        const f = w[field];
        const inn = inList(f);
        const out = notInList(f);
        if (typeof f === "string" && field in r && r[field] !== f) return false;
        if (inn && field in r && !inn.includes(r[field] as string)) return false;
        if (out && field in r && out.includes(r[field] as string)) return false;
        if ("dryRun" in w && r.dryRun !== w.dryRun) return false;
        return true;
      });
    });
  const prisma = {
    migrationRun: { findMany: fm("run", "status") },
    coolifyTakeover: { findMany: fm("takeover", "status") },
    coolifyCleanup: { findMany: fm("cleanup", "status") },
    cutoverRun: { findMany: fm("cutover", "status") },
    cutoverDomain: { findMany: jest.fn(async () => rows.cutoverDomain ?? []) },
    projectMove: { findMany: fm("projectMove", "phase") },
    appMove: { findMany: fm("appMove", "phase") },
    migrationVolumeTransfer: { findMany: fm("transfer", "state") },
    objectMigration: { findMany: fm("object", "status") },
    server: { findMany: jest.fn(async () => rows.server ?? []) },
    bulkOperation: {
      findMany: jest.fn(async (args: { where: { kind: string } }) => ((args.where.kind === "import" ? rows.import : rows.bulk) ?? []) as unknown[]),
    },
    deployment: { findMany: fm("deployment", "status") },
    backup: { findMany: fm("backup", "status") },
    baseBackup: { findMany: fm("baseBackup", "status") },
    volumeBackup: { findMany: fm("volumeBackup", "status") },
    hubBackup: { findMany: fm("hubBackup", "status") },
    restore: { findMany: fm("restore", "status") },
    hubBackupDrill: { findMany: fm("drill", "status") },
    rollout: { findMany: fm("rollout", "status") },
    auditLog: { findMany: jest.fn(async () => rows.audit ?? []) },
    cluster: { findMany: fm("cluster", "swarmStatus") },
    serverReboot: { findMany: fm("reboot", "state") },
    database: { findMany: jest.fn(async () => rows.database ?? []) },
  };
  const registry = new InFlightRegistry();
  return { svc: new InFlightService(prisma as unknown as PrismaService, registry), registry, prisma: prisma as unknown as Record<string, { findMany: jest.Mock }> };
}

const run = (over: Record<string, unknown> = {}) => ({
  id: "run1",
  teamId: "t1",
  status: "RUNNING",
  dryRun: false,
  targetServerId: "s1",
  serverMap: null,
  agentServerId: null,
  sourceKind: "coolify",
  sourceHost: "coolify.example.com",
  opId: null,
  opHistory: [],
  startedAt: T0,
  createdAt: T0,
  steps: [{ status: "PASSED" }],
  ...over,
});

describe("InFlightService.list", () => {
  it("is empty when nothing is running", async () => {
    expect(await make({}).svc.list()).toEqual([]);
  });

  describe("migration runs", () => {
    it("lists a started real run with its target, mapped and agent servers, team, label and start", async () => {
      const { svc } = make({ run: [run({ serverMap: { "uuid-a": "s2", "uuid-b": "s3" }, agentServerId: "s4" })] });
      expect(await svc.list()).toEqual([{ kind: "migration-run", id: "run1", label: "coolify.example.com", serverIds: ["s1", "s2", "s3", "s4"], teamId: "t1", since: T0.toISOString() }]);
    });

    it.each(["RUNNING", "WAITING", "PAUSED", "ABORTING", "ROLLING_BACK", "REVERSING", "FAILED"])("counts a %s run", async (status) => {
      expect(await make({ run: [run({ status })] }).svc.list()).toHaveLength(1);
    });

    it.each([...TERMINAL_RUN_STATUSES])("does not count a %s run", async (status) => {
      expect(await make({ run: [run({ status })] }).svc.list()).toEqual([]);
    });

    it("asks for non-terminal real runs only (terminal statuses and dry runs are in the query)", async () => {
      const { svc, prisma } = make({});
      await svc.list();
      const where = prisma.migrationRun.findMany.mock.calls[0][0].where;
      expect(where.dryRun).toBe(false);
      expect(where.status.notIn).toEqual([...TERMINAL_RUN_STATUSES]);
    });

    it("never counts a dry run, whatever its status", async () => {
      expect(await make({ run: [run({ dryRun: true, status: "RUNNING" }), run({ id: "r2", dryRun: true, status: "WAITING" })] }).svc.list()).toEqual([]);
    });

    it("does not count a real run that was created but never started (QUEUED, nothing begun)", async () => {
      const queued = run({ status: "QUEUED", startedAt: null, steps: [{ status: "PENDING" }, { status: "PENDING" }] });
      expect(await make({ run: [queued] }).svc.list()).toEqual([]);
    });

    it("counts a QUEUED run once it has started or a step has moved (waiting on an approval)", async () => {
      const started = run({ id: "a", status: "QUEUED", startedAt: T0, steps: [{ status: "PENDING" }] });
      const approval = run({ id: "b", status: "QUEUED", startedAt: null, steps: [{ status: "PASSED" }, { status: "WAITING_APPROVAL" }] });
      expect((await make({ run: [started, approval] }).svc.list()).map((i) => i.id).sort()).toEqual(["a", "b"]);
    });

    it("a run with no host reads as its source kind; since falls back to creation", async () => {
      const [item] = await make({ run: [run({ sourceHost: null, startedAt: null, createdAt: T1, status: "PAUSED" })] }).svc.list();
      expect(item).toMatchObject({ label: "coolify", since: T1.toISOString() });
    });
  });

  describe("takeovers", () => {
    const takeover = (status: string, over: Record<string, unknown> = {}) => ({ id: "tk1", teamId: "t1", serverId: "s1", runId: null, status, createdAt: T0, ...over });

    it.each(TAKEOVER_ACTIVE)("counts a %s takeover (named after its server)", async (status) => {
      const { svc } = make({ takeover: [takeover(status)], server: [{ id: "s1", name: "edge-1", teamId: "t1" }] });
      expect(await svc.list()).toEqual([{ kind: "takeover", id: "tk1", label: "edge-1", serverIds: ["s1"], teamId: "t1", since: T0.toISOString() }]);
    });

    it.each(["PLANNED", "VERIFIED", "GIVEN_BACK", "FAILED"])("does not count a %s takeover", async (status) => {
      expect(await make({ takeover: [takeover(status)] }).svc.list()).toEqual([]);
    });

    it("does not list a takeover twice when the run that carries it is listed", async () => {
      const { svc } = make({ run: [run()], takeover: [takeover("SWAPPING", { runId: "run1" })] });
      expect((await svc.list()).map((i) => i.kind)).toEqual(["migration-run"]);
    });

    it("lists a takeover whose run is not in flight (a dry run, never started)", async () => {
      expect((await make({ run: [run({ dryRun: true })], takeover: [takeover("TESTING", { runId: "run1" })] }).svc.list()).map((i) => i.kind)).toEqual(["takeover"]);
    });
  });

  describe("cleanups", () => {
    const cleanup = (status: string) => ({ id: "cl1", teamId: "t1", serverId: "s1", status, createdAt: T0 });
    it.each(CLEANUP_ACTIVE)("counts a %s cleanup", async (status) => {
      expect((await make({ cleanup: [cleanup(status)] }).svc.list())[0]).toMatchObject({ kind: "cleanup", id: "cl1", serverIds: ["s1"], teamId: "t1" });
    });
    it.each(["INCOMPLETE", "READY", "CLEANED", "FAILED"])("does not count a %s cleanup", async (status) => {
      expect(await make({ cleanup: [cleanup(status)] }).svc.list()).toEqual([]);
    });
    it("ignores a cleanup nobody has touched for a long while (the cleanup service treats it as abandoned)", async () => {
      const { svc, prisma } = make({});
      const before = Date.now();
      await svc.list();
      const since = prisma.coolifyCleanup.findMany.mock.calls[0][0].where.updatedAt.gt as Date;
      expect(before - since.getTime()).toBeGreaterThanOrEqual(CLEANUP_STALE_MS - 50);
      expect(before - since.getTime()).toBeLessThan(CLEANUP_STALE_MS + 5_000);
    });
  });

  describe("DNS cutovers", () => {
    it("counts a running flip, with the servers and team of its apps", async () => {
      const { svc } = make({
        cutover: [{ id: "cu1", opId: "op1", status: "running", startedAt: T0 }],
        cutoverDomain: [
          { opId: "op1", application: { serverId: "s1", teamId: "t1" } },
          { opId: "op1", application: { serverId: "s2", teamId: "t1" } },
          { opId: "op1", application: { serverId: "s1", teamId: "t1" } },
        ],
      });
      expect(await svc.list()).toEqual([{ kind: "cutover", id: "cu1", label: "op1", serverIds: ["s1", "s2"], teamId: "t1", since: T0.toISOString() }]);
    });
    it.each(["halted", "done", "cancelled"])("does not count a %s run", async (status) => {
      expect(await make({ cutover: [{ id: "cu1", opId: "op1", status, startedAt: T0 }] }).svc.list()).toEqual([]);
    });
    it("asks only for a run that is active and still beating (a dead one is not in flight)", async () => {
      const { svc, prisma } = make({});
      const before = Date.now();
      await svc.list();
      const where = prisma.cutoverRun.findMany.mock.calls[0][0].where;
      expect(where.activeKey).toEqual({ not: null });
      expect(before - (where.heartbeatAt.gt as Date).getTime()).toBeGreaterThanOrEqual(CUTOVER_ALIVE_MS - 50);
    });
    it("a flip over apps of two teams has no single team", async () => {
      const { svc } = make({
        cutover: [{ id: "cu1", opId: "op1", status: "running", startedAt: T0 }],
        cutoverDomain: [{ opId: "op1", application: { serverId: "s1", teamId: "t1" } }, { opId: "op1", application: { serverId: "s2", teamId: "t2" } }],
      });
      expect((await svc.list())[0].teamId).toBeNull();
    });
  });

  describe("project and app moves", () => {
    const pm = (phase: string, over: Record<string, unknown> = {}) => ({ id: "pm1", teamId: "t1", sourceServerId: "s1", targetServerId: "s2", phase, items: [], startedAt: T0, createdAt: T0, ...over });
    const am = (phase: string, over: Record<string, unknown> = {}) => ({ id: "am1", teamId: "t1", appName: "shop", sourceServerId: "s1", targetServerId: "s2", phase, startedAt: null, createdAt: T1, ...over });

    it.each(PROJECT_MOVE_ACTIVE)("counts a %s project move", async (phase) => {
      expect(await make({ projectMove: [pm(phase)] }).svc.list()).toEqual([{ kind: "project-move", id: "pm1", label: "pm1", serverIds: ["s1", "s2"], teamId: "t1", since: T0.toISOString() }]);
    });
    it.each(["COMPLETED", "ROLLED_BACK", "FAILED"])("does not count a %s project move", async (phase) => {
      expect(await make({ projectMove: [pm(phase)] }).svc.list()).toEqual([]);
    });

    it.each(["QUEUED", "PRECHECK", "STOPPING_SOURCE", "TRANSFERRING", "DEPLOYING", "FINALIZING", "ROLLING_BACK"])("counts an app move in %s", async (phase) => {
      expect(await make({ appMove: [am(phase)] }).svc.list()).toEqual([{ kind: "app-move", id: "am1", label: "shop", serverIds: ["s1", "s2"], teamId: "t1", since: T1.toISOString() }]);
    });
    it.each(["COMPLETED", "ROLLED_BACK", "FAILED"])("does not count an app move in %s", async (phase) => {
      expect(await make({ appMove: [am(phase)] }).svc.list()).toEqual([]);
    });

    it("an app move that a listed project move carries is not listed twice", async () => {
      const { svc } = make({ projectMove: [pm("MOVING", { items: [{ kind: "app", childId: "am1" }, { kind: "database", childId: null }] })], appMove: [am("TRANSFERRING"), am("QUEUED", { id: "am2" })] });
      expect((await svc.list()).map((i) => i.id).sort()).toEqual(["am2", "pm1"]);
    });
  });

  describe("volume and object transfers", () => {
    const vt = (state: string, over: Record<string, unknown> = {}) => ({ id: "vt1", opId: "op1", itemRef: "volume:_:abc:data", targetServerId: "s1", startedAt: T0, createdAt: T1, state, ...over });
    it.each(VOLUME_TRANSFER_ACTIVE)("counts a volume copy in %s", async (state) => {
      const { svc } = make({ transfer: [vt(state)], server: [{ id: "s1", name: "edge-1", teamId: "t1" }] });
      expect(await svc.list()).toEqual([{ kind: "volume-transfer", id: "vt1", label: "volume:_:abc:data", serverIds: ["s1"], teamId: "t1", since: T0.toISOString() }]);
    });
    it.each(["PENDING", "DONE", "FAILED", "ABORTED"])("does not count a volume copy in %s", async (state) => {
      expect(await make({ transfer: [vt(state)] }).svc.list()).toEqual([]);
    });
    it("does not list a transfer twice when the run that owns its operation is listed", async () => {
      const { svc } = make({ run: [run({ opId: "op1" })], transfer: [vt("COPYING")] });
      expect((await svc.list()).map((i) => i.kind)).toEqual(["migration-run"]);
      const { svc: svc2 } = make({ run: [run({ opId: "op9", opHistory: ["op1"] })], transfer: [vt("COPYING")] });
      expect((await svc2.list()).map((i) => i.kind)).toEqual(["migration-run"]);
    });

    const ob = (status: string) => ({ id: "ob1", teamId: "t1", name: "assets", targetServerId: "s1", createdAt: T0, updatedAt: T1, status });
    it.each(OBJECT_MIGRATION_ACTIVE)("counts an object migration in %s", async (status) => {
      expect(await make({ object: [ob(status)] }).svc.list()).toEqual([{ kind: "object-migration", id: "ob1", label: "assets", serverIds: ["s1"], teamId: "t1", since: T0.toISOString() }]);
    });
    it.each(["DRAFT", "PREFLIGHTED", "SEEDED", "FINAL", "DONE", "FAILED"])("does not count an object migration in %s", async (status) => {
      expect(await make({ object: [ob(status)] }).svc.list()).toEqual([]);
    });
  });

  it("returns everything, oldest first", async () => {
    const { svc } = make({
      run: [run({ startedAt: T1 })],
      cleanup: [{ id: "cl1", teamId: "t1", serverId: "s9", status: "CLEANING", createdAt: T0 }],
    });
    expect((await svc.list()).map((i) => i.kind)).toEqual(["cleanup", "migration-run"]);
  });
});

describe("InFlightService per server", () => {
  const rows: Rows = {
    run: [run({ targetServerId: "s1" })],
    appMove: [{ id: "am1", teamId: "t1", appName: "shop", sourceServerId: "s2", targetServerId: "s3", phase: "DEPLOYING", startedAt: T0, createdAt: T0 }],
  };

  it("listForServers returns only what touches the given servers", async () => {
    const { svc } = make(rows);
    expect((await svc.listForServers(["s3"])).map((i) => i.id)).toEqual(["am1"]);
    expect((await svc.listForServers(["s1", "s2"])).map((i) => i.id).sort()).toEqual(["am1", "run1"]);
    expect(await svc.listForServers(["s9"])).toEqual([]);
  });

  it("byServer groups by server and leaves out free ones", async () => {
    const items = await make(rows).svc.list();
    const by = InFlightService.byServer(items, ["s1", "s2", "s3", "s9"]);
    expect([...by.keys()].sort()).toEqual(["s1", "s2", "s3"]);
    expect(by.get("s2")?.map((i) => i.id)).toEqual(["am1"]);
  });
});

const db = { name: "orders", serverId: "s1", teamId: "t1" };
const app = { name: "shop", serverId: "s1", buildServerId: null, teamId: "t1" };

describe("InFlightService: wider sources (the hub is idle only when none of these runs)", () => {
  describe("deployments", () => {
    const dep = (status: string, over: Record<string, unknown> = {}) => ({ id: "d1", status, runServerId: null, startedAt: T0, createdAt: T1, application: app, ...over });
    it.each([...DEPLOYMENT_ACTIVE])("counts a %s deployment, on the app's server and its build server", async (status) => {
      const { svc } = make({ deployment: [dep(status, { application: { ...app, buildServerId: "s7" } })] });
      expect(await svc.list()).toEqual([{ kind: "deployment", id: "d1", label: "shop", serverIds: ["s1", "s7"], teamId: "t1", since: T0.toISOString() }]);
    });
    it.each(["SUCCESS", "FAILED", "CANCELLED"])("does not count a %s deployment", async (status) => {
      expect(await make({ deployment: [dep(status)] }).svc.list()).toEqual([]);
    });
    it("a deploy stamped with another server runs there", async () => {
      expect((await make({ deployment: [dep("RUNNING", { runServerId: "s2" })] }).svc.list())[0].serverIds).toEqual(["s2"]);
    });
    it("ignores a deployment row older than a deploy can last (a crash leftover)", async () => {
      const { svc, prisma } = make({});
      const before = Date.now();
      await svc.list();
      const gt = prisma.deployment.findMany.mock.calls[0][0].where.createdAt.gt as Date;
      expect(before - gt.getTime()).toBeGreaterThanOrEqual(ORPHAN_MS.deployment - 50);
    });
  });

  describe("backups", () => {
    it("counts a running database, base (PITR), volume and hub backup", async () => {
      const { svc } = make({
        backup: [{ id: "b1", createdAt: T0, database: db }],
        baseBackup: [{ id: "b2", createdAt: T0, database: db }],
        volumeBackup: [{ id: "b3", createdAt: T0, volumeName: "data", app }],
        hubBackup: [{ id: "b4", createdAt: T0 }],
      });
      const out = await svc.list();
      expect(out.map((i) => `${i.kind}:${i.id}:${i.label}`).sort()).toEqual(["backup:b1:orders", "backup:b2:orders", "backup:b3:shop:data", "backup:b4:hub"]);
      expect(out.find((i) => i.id === "b1")).toMatchObject({ serverIds: ["s1"], teamId: "t1" });
      expect(out.find((i) => i.id === "b4")).toMatchObject({ serverIds: [], teamId: null });
    });
    it("asks for RUNNING backups only: a finished or failed one is not in the query", async () => {
      const { svc, prisma } = make({});
      await svc.list();
      for (const m of ["backup", "baseBackup", "volumeBackup", "hubBackup"]) expect(prisma[m].findMany.mock.calls[0][0].where.status).toEqual({ in: ["RUNNING"] });
    });
    it("a stub that applies the filter drops SUCCESS and FAILED rows", async () => {
      const { svc } = make({ backup: [{ id: "x", status: "SUCCESS", createdAt: T0, database: db }, { id: "y", status: "FAILED", createdAt: T0, database: db }, { id: "z", status: "RUNNING", createdAt: T0, database: db }] });
      expect((await svc.list()).map((i) => i.id)).toEqual(["z"]);
    });
  });

  describe("restores, PITR restores and restore drills", () => {
    const rs = (kind: string, over: Record<string, unknown> = {}) => ({ id: `r-${kind}`, kind, status: "RUNNING", createdAt: T0, targetDatabaseId: null, database: db, ...over });
    it("tells restore, point-in-time restore and verify apart", async () => {
      const { svc } = make({ restore: [rs("RESTORE"), rs("RESTORE_TO"), rs("IMPORT_URL"), rs("PITR"), rs("VERIFY")] });
      expect((await svc.list()).map((i) => `${i.id}=${i.kind}`).sort()).toEqual([
        "r-IMPORT_URL=restore", "r-PITR=pitr-restore", "r-RESTORE=restore", "r-RESTORE_TO=restore", "r-VERIFY=restore-verify",
      ]);
    });
    it("a PITR restore touches the source and the target database's server", async () => {
      const { svc } = make({ restore: [rs("PITR", { targetDatabaseId: "db2" })], database: [{ id: "db2", serverId: "s5" }] });
      expect((await svc.list())[0].serverIds).toEqual(["s1", "s5"]);
    });
    it("does not count finished restores", async () => {
      expect(await make({ restore: [rs("RESTORE", { status: "SUCCESS" }), rs("PITR", { status: "FAILED" })] }).svc.list()).toEqual([]);
    });
    it("a plain restore older than two hours is a leftover; a point-in-time replay of the same age is not", async () => {
      const old = new Date(Date.now() - 3 * 3_600_000);
      const { svc } = make({ restore: [rs("RESTORE", { createdAt: old }), rs("PITR", { createdAt: old })] });
      expect((await svc.list()).map((i) => i.kind)).toEqual(["pitr-restore"]);
    });
    it("counts a running restore drill of the hub's own backup", async () => {
      expect(await make({ drill: [{ id: "dr1", status: "RUNNING", createdAt: T0 }, { id: "dr2", status: "SUCCESS", createdAt: T0 }] }).svc.list()).toEqual([
        { kind: "restore-verify", id: "dr1", label: "hub", serverIds: [], teamId: null, since: T0.toISOString() },
      ]);
    });
  });

  describe("staged rollouts and agent updates", () => {
    const ro = (status: string) => ({ id: "ro1", teamId: "t1", name: "web wave", status, createdAt: T0, targets: [{ serverId: "s1" }, { serverId: "s2" }, { serverId: "s1" }] });
    it.each([...ROLLOUT_ACTIVE])("counts a %s rollout with the servers of its open targets", async (status) => {
      expect(await make({ rollout: [ro(status)] }).svc.list()).toEqual([{ kind: "rollout", id: "ro1", label: "web wave", serverIds: ["s1", "s2"], teamId: "t1", since: T0.toISOString() }]);
    });
    it.each(["HALTED", "COMPLETED", "ROLLED_BACK", "ROLLBACK_FAILED", "CANCELLED"])("does not count a %s rollout", async (status) => {
      expect(await make({ rollout: [ro(status)] }).svc.list()).toEqual([]);
    });
    it("only asks for targets the rollout still has to act on", async () => {
      const { svc, prisma } = make({});
      await svc.list();
      expect(prisma.rollout.findMany.mock.calls[0][0].select.targets.where).toEqual({ active: true, status: { in: ["PENDING", "DEPLOYING", "REVERTING"] } });
    });
    it("an agent update the hub sent counts until the agent is back on the version it was sent", async () => {
      const req = { id: "a1", target: "s1", createdAt: T0, meta: { to: "0.2.0" } };
      const waiting = make({ audit: [req], server: [{ id: "s1", name: "edge-1", teamId: "t1" }] });
      waiting.prisma.server.findMany.mockImplementation(async (a: { select: Record<string, boolean> }) => (a.select.agentVersion ? [{ id: "s1", agentVersion: "0.1.0" }] : [{ id: "s1", name: "edge-1", teamId: "t1" }]));
      expect(await waiting.svc.list()).toEqual([{ kind: "agent-update", id: "a1", label: "edge-1", serverIds: ["s1"], teamId: "t1", since: T0.toISOString() }]);
      const back = make({ audit: [req] });
      back.prisma.server.findMany.mockImplementation(async () => [{ id: "s1", agentVersion: "0.2.0" }]);
      expect(await back.svc.list()).toEqual([]);
    });
    it("only looks at agent updates sent in the last ten minutes", async () => {
      const { svc, prisma } = make({});
      const before = Date.now();
      await svc.list();
      const w = prisma.auditLog.findMany.mock.calls[0][0].where;
      expect(w.action).toBe("agent.update.request");
      expect(before - (w.createdAt.gt as Date).getTime()).toBeGreaterThanOrEqual(ORPHAN_MS.agentUpdate - 50);
    });
  });

  describe("swarm, reboots, imports, fleet commands", () => {
    it.each([...SWARM_BUSY])("counts a cluster that is %s, with its member servers", async (swarmStatus) => {
      const c = { id: "c1", name: "prod", teamId: "t1", swarmStatus, updatedAt: T0, servers: [{ id: "s1" }, { id: "s2" }] };
      expect(await make({ cluster: [c] }).svc.list()).toEqual([{ kind: "swarm", id: "c1", label: "prod", serverIds: ["s1", "s2"], teamId: "t1", since: T0.toISOString() }]);
    });
    it.each(["NONE", "ACTIVE", "DEGRADED"])("does not count a %s swarm", async (swarmStatus) => {
      expect(await make({ cluster: [{ id: "c1", name: "prod", teamId: "t1", swarmStatus, updatedAt: T0, servers: [] }] }).svc.list()).toEqual([]);
    });
    it("a promote, demote, ingress change or server patch registered in this process counts until it settles", async () => {
      const { svc, registry } = make({});
      let release!: () => void;
      const done = registry.track({ kind: "patch", label: "s1", serverIds: ["s1"] }, () => new Promise<void>((r) => (release = r)));
      const during = await svc.list();
      expect(during).toHaveLength(1);
      expect(during[0]).toMatchObject({ kind: "patch", serverIds: ["s1"] });
      // concurrent calls on the same thing do not clobber each other
      const second = registry.track({ kind: "patch", id: "s1", label: "s1", serverIds: ["s1"] }, async () => undefined);
      await second;
      expect(await svc.list()).toHaveLength(1);
      expect(await svc.listForServers(["s2"])).toEqual([]);
      release();
      await done;
      expect(await svc.list()).toEqual([]);
    });
    it("a registered call that throws is removed too", async () => {
      const { svc, registry } = make({});
      await expect(registry.track({ kind: "swarm", label: "c1", serverIds: [] }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
      expect(await svc.list()).toEqual([]);
    });

    const rb = (state: string) => ({ id: "rb1", serverId: "s1", state, startedAt: null, createdAt: T0 });
    it.each(REBOOT_ACTIVE)("counts a reboot in %s", async (state) => {
      const { svc } = make({ reboot: [rb(state)], server: [{ id: "s1", name: "edge-1", teamId: "t1" }] });
      expect(await svc.list()).toEqual([{ kind: "reboot", id: "rb1", label: "edge-1", serverIds: ["s1"], teamId: "t1", since: T0.toISOString() }]);
    });
    it.each(["SCHEDULED", "DONE"])("does not count a reboot that is %s (scheduled is for later)", async (state) => {
      expect(await make({ reboot: [rb(state)] }).svc.list()).toEqual([]);
    });

    it("counts an import apply with queued or running tasks, on its target and placed servers", async () => {
      const op = { id: "imp1", createdAt: T0, meta: { serverId: "s1", sourceKind: "coolify" }, tasks: [{ serverId: "s1" }, { serverId: "s2" }] };
      const { svc } = make({ import: [op], server: [{ id: "s1", name: "a", teamId: "t1" }, { id: "s2", name: "b", teamId: "t1" }] });
      expect(await svc.list()).toEqual([{ kind: "import", id: "imp1", label: "coolify", serverIds: ["s1", "s2"], teamId: "t1", since: T0.toISOString() }]);
    });
    it("asks only for import operations with PENDING or RUNNING tasks (staged and finished ones are out)", async () => {
      const { svc, prisma } = make({});
      await svc.list();
      const importCall = prisma.bulkOperation.findMany.mock.calls.find((c) => c[0].where.kind === "import")![0];
      expect(importCall.where.tasks).toEqual({ some: { status: { in: ["PENDING", "RUNNING"] } } });
    });
    it("an import that a listed run carries is not listed twice", async () => {
      const op = { id: "op1", createdAt: T0, meta: { serverId: "s1" }, tasks: [{ serverId: "s1" }] };
      const { svc } = make({ run: [run({ opId: "op1" })], import: [op] });
      expect((await svc.list()).map((i) => i.kind)).toEqual(["migration-run"]);
    });
    it("counts a fleet command that still has queued or running servers", async () => {
      const { svc } = make({ bulk: [{ id: "bk1", createdAt: T0, tasks: [{ serverId: "s1" }, { serverId: "s2" }] }], server: [{ id: "s1", name: "a", teamId: "t1" }, { id: "s2", name: "b", teamId: "t2" }] });
      expect(await svc.list()).toEqual([{ kind: "bulk-command", id: "bk1", label: "bk1", serverIds: ["s1", "s2"], teamId: null, since: T0.toISOString() }]);
    });
  });

  it("work scheduled for later is never read: no query asks for SCHEDULED, DRAFT or PLANNED rows", async () => {
    const { svc, prisma } = make({});
    await svc.list();
    const asked = JSON.stringify(Object.values(prisma).flatMap((m) => m.findMany.mock.calls.map((c) => c[0].where)));
    for (const later of ["SCHEDULED", "DRAFT", "PLANNED"]) expect(asked).not.toContain(`"${later}"`);
  });
});

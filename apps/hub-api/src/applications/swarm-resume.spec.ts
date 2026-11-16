import { DeploymentReconcileService } from "./deployment-reconcile.service";
import { DeployRecoveryService } from "./deploy-recovery.service";

/**
 * Hub-restart lifecycle of SWARM deploys, run against a small in-memory Deployment table so the real
 * DeploymentReconcileService / DeployRecoveryService where-clauses are evaluated (not just asserted as shapes):
 * restart while queued, restart mid-build (pre-dispatch), restart mid-rollout (journaled), repeated restarts.
 */

type Row = {
  id: string;
  appId: string;
  status: string;
  startedAt: Date | null;
  ownerId: string | null;
  heartbeatAt: Date | null;
  phase: string | null;
  agentReqId: string | null;
  agentServerId: string | null;
  deadlineAt: Date | null;
  exitCode: number | null;
  logs: string | null;
  clusterId: string | null;
  createdAt: Date;
};

const row = (over: Partial<Row> = {}): Row => ({
  id: "d1",
  appId: "app1",
  status: "RUNNING",
  startedAt: new Date(),
  ownerId: "boot-old",
  heartbeatAt: new Date(),
  phase: "CLAIMED",
  agentReqId: null,
  agentServerId: null,
  deadlineAt: null,
  exitCode: null,
  logs: null,
  clusterId: "c1",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  ...over,
});

/** Minimal Prisma `where` evaluator covering exactly the operators the recovery code uses. */
function matches(r: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as Array<Record<string, unknown>>).some((c) => matches(r, c));
    if (k === "AND") return (cond as Array<Record<string, unknown>>).every((c) => matches(r, c));
    if (k === "application") return matches({ clusterId: r.clusterId }, cond as Record<string, unknown>);
    const v = r[k] ?? null;
    if (cond === null) return v === null;
    if (cond && typeof cond === "object") {
      const c = cond as { not?: unknown; in?: unknown[] };
      if ("in" in c) return c.in!.includes(v);
      if ("not" in c) return c.not === null ? v !== null : v !== null && v !== c.not; // SQL: `<> x` never matches NULL
    }
    return v === cond;
  });
}

function table(rows: Row[]) {
  return {
    deployment: {
      findMany: jest.fn(async (a: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, a.where)).map((r) => ({ ...r }))),
      findUnique: jest.fn(async (a: { where: { id: string } }) => rows.find((r) => r.id === a.where.id) ?? null),
      updateMany: jest.fn(async (a: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = rows.filter((r) => matches(r, a.where));
        for (const r of hit) Object.assign(r, a.data);
        return { count: hit.length };
      }),
    },
  };
}

const find = (rows: Row[], id: string) => rows.find((r) => r.id === id)!;

describe("swarm deploy hub-restart lifecycle", () => {
  it("restart while QUEUED: the row is untouched (it re-drives when the cluster is reachable) — not cancelled", async () => {
    const rows = [row({ id: "q1", status: "QUEUED", startedAt: null, ownerId: null, phase: null })];
    await new DeploymentReconcileService(table(rows) as never, { bootId: "boot-new" } as never).onApplicationBootstrap();
    expect(find(rows, "q1")).toMatchObject({ status: "QUEUED", logs: null, exitCode: null });
  });

  it("restart mid-build (PREPARING, nothing journaled): the row goes back to QUEUED with its place (createdAt) and no terminal markers", async () => {
    const rows = [row({ id: "p1", phase: "PREPARING" }), row({ id: "q2", status: "QUEUED", startedAt: null, ownerId: null, phase: null, appId: "app1", createdAt: new Date("2026-11-02T00:00:00Z") })];
    await new DeploymentReconcileService(table(rows) as never, { bootId: "boot-new" } as never).onApplicationBootstrap();
    expect(find(rows, "p1")).toMatchObject({ status: "QUEUED", startedAt: null, ownerId: null, phase: null, exitCode: null, logs: null });
    expect(find(rows, "p1").createdAt).toEqual(new Date("2026-11-01T00:00:00Z")); // older than q2 → claimNext runs it first
  });

  it("restart mid-rollout (DISPATCHED, journaled on the manager): kept RUNNING and released for adoption — never re-queued, never failed", async () => {
    const rows = [row({ id: "r1", phase: "DISPATCHED", agentReqId: "dep-r1", agentServerId: "mgr1", deadlineAt: new Date(Date.now() + 60_000) })];
    await new DeploymentReconcileService(table(rows) as never, { bootId: "boot-new" } as never).onApplicationBootstrap();
    expect(find(rows, "r1")).toMatchObject({ status: "RUNNING", ownerId: null, phase: "RECOVERING", agentReqId: "dep-r1", agentServerId: "mgr1" });
  });

  it("a swarm deploy on an agent WITHOUT a journal (phase CLAIMED, no reqId) is still reaped to the legacy interrupted FAILED", async () => {
    const rows = [row({ id: "o1", phase: "CLAIMED" })];
    await new DeploymentReconcileService(table(rows) as never, { bootId: "boot-new" } as never).onApplicationBootstrap();
    expect(find(rows, "o1")).toMatchObject({ status: "FAILED", exitCode: -1 });
  });

  it("rows owned by THIS boot are never touched (an agent reconnect hook can legitimately claim one during bootstrap)", async () => {
    const rows = [row({ id: "m1", phase: "PREPARING", ownerId: "boot-new" }), row({ id: "m2", phase: "DISPATCHED", agentReqId: "dep-m2", agentServerId: "mgr1", ownerId: "boot-new", appId: "app2" })];
    await new DeploymentReconcileService(table(rows) as never, { bootId: "boot-new" } as never).onApplicationBootstrap();
    expect(find(rows, "m1")).toMatchObject({ status: "RUNNING", phase: "PREPARING" });
    expect(find(rows, "m2")).toMatchObject({ status: "RUNNING", phase: "DISPATCHED" });
  });

  it("idempotent across repeated restarts: a re-queued row is not re-processed, and an adoptable row stays adoptable (second boot with another bootId changes nothing it should not)", async () => {
    const rows = [row({ id: "p1", phase: "PREPARING" }), row({ id: "r1", appId: "app2", phase: "DISPATCHED", agentReqId: "dep-r1", agentServerId: "mgr1" })];
    const t = table(rows);
    await new DeploymentReconcileService(t as never, { bootId: "boot-2" } as never).onApplicationBootstrap();
    const snapshot = JSON.stringify(rows);
    await new DeploymentReconcileService(t as never, { bootId: "boot-3" } as never).onApplicationBootstrap();
    expect(JSON.stringify(rows)).toBe(snapshot); // p1 already QUEUED, r1 already RECOVERING with no owner: nothing matches twice
    expect(find(rows, "p1").status).toBe("QUEUED");
    expect(find(rows, "r1")).toMatchObject({ status: "RUNNING", phase: "RECOVERING" });
  });

  it("end to end: boot releases the journaled rollout, the MANAGER reconnecting adopts it (asks the journal, finalizes, NEVER re-sends); a plain member reconnecting adopts nothing", async () => {
    const rows = [row({ id: "r1", phase: "DISPATCHED", agentReqId: "dep-r1", agentServerId: "mgr1", deadlineAt: new Date(Date.now() + 600_000) })];
    const t = table(rows);
    await new DeploymentReconcileService(t as never, { bootId: "boot-new" } as never).onApplicationBootstrap();
    const adoptCommand = jest.fn().mockResolvedValue({ kind: "result", exitCode: 3, output: "TUGRA rolled back", killed: false });
    const sendCommand = jest.fn();
    const agentWs = {
      isOnline: jest.fn(() => true),
      agentSupports: jest.fn(() => true),
      adoptCommand,
      sendCommand,
    };
    const apps = { setLeaseReleasedHook: jest.fn(), finalizeAdopted: jest.fn().mockResolvedValue(undefined), settleInterrupted: jest.fn().mockResolvedValue(true) };
    const rec = new DeployRecoveryService(t as never, agentWs as never, apps as never, { bootId: "boot-new" } as never, { begin: jest.fn(), push: jest.fn() } as never);
    await rec.adoptForServer("worker1");
    expect(adoptCommand).not.toHaveBeenCalled();
    await rec.adoptForServer("mgr1");
    expect(adoptCommand).toHaveBeenCalledTimes(1);
    expect(adoptCommand).toHaveBeenCalledWith("mgr1", "dep-r1", expect.any(Function), expect.any(Number));
    expect(apps.finalizeAdopted).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }), { kind: "result", exitCode: 3, output: "TUGRA rolled back", killed: false });
    expect(sendCommand).not.toHaveBeenCalled(); // adoption never re-sends → no double-apply
    // a second reconnect/ticker race on the same (now owned) row is a no-op
    await rec.adoptForServer("mgr1");
    expect(adoptCommand).toHaveBeenCalledTimes(1);
  });

  it("the manager never returns: the ticker settles the journaled rollout as interrupted only past its deadline (Application.status untouched by the settle)", async () => {
    const rows = [row({ id: "r1", phase: "RECOVERING", ownerId: null, agentReqId: "dep-r1", agentServerId: "mgr1", deadlineAt: new Date(Date.now() - 1000) })];
    const agentWs = { isOnline: jest.fn(() => false), agentSupports: jest.fn(() => false), adoptCommand: jest.fn() };
    const apps = { setLeaseReleasedHook: jest.fn(), finalizeAdopted: jest.fn(), settleInterrupted: jest.fn().mockResolvedValue(true) };
    const rec = new DeployRecoveryService(table(rows) as never, agentWs as never, apps as never, { bootId: "boot-new" } as never, { begin: jest.fn(), push: jest.fn() } as never);
    await rec.sweep();
    expect(apps.settleInterrupted).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }), expect.stringContaining("deadline"));
    expect(agentWs.adoptCommand).not.toHaveBeenCalled();
  });
});

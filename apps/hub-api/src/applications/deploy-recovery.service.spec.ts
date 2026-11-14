import { DeployRecoveryService } from "./deploy-recovery.service";
import { AgentDisconnectedException } from "../agent-gateway/agent-offline.exception";

const BOOT = "boot-new";
const NOW = Date.now();

type Row = Record<string, unknown> & { id: string; appId: string; status: string; ownerId: string | null; phase: string | null; agentReqId: string | null; agentServerId: string | null; deadlineAt: Date | null };
const row = (over: Partial<Row> = {}): Row => ({ id: "d1", appId: "app1", status: "RUNNING", ownerId: "boot-old", phase: "DISPATCHED", agentReqId: "dep-d1", agentServerId: "s1", deadlineAt: new Date(NOW + 600_000), dispatchPlan: { v: 1 }, ...over });

function make(rows: Row[], opts: { online?: string[]; features?: string[]; adopt?: jest.Mock } = {}) {
  const online = new Set(opts.online ?? ["s1"]);
  const feats = new Set(opts.features ?? ["cmd_journal_v1"]);
  const match = (r: Row, where: Record<string, unknown>) => {
    if (where.status && r.status !== where.status) return false;
    if (where.agentServerId && r.agentServerId !== where.agentServerId) return false;
    const ph = where.phase as { in?: string[]; not?: string } | undefined;
    if (ph?.in && !ph.in.includes(r.phase ?? "")) return false;
    if ((where.agentReqId as { not?: unknown } | undefined)?.not === null && r.agentReqId === null) return false;
    if ("ownerId" in where && !(where.ownerId instanceof Object) && r.ownerId !== where.ownerId) return false;
    const or = where.OR as Array<Record<string, unknown>> | undefined;
    if (or && !or.some((c) => ("ownerId" in c && c.ownerId === null ? r.ownerId === null : (c.ownerId as { not?: string })?.not !== undefined ? r.ownerId !== (c.ownerId as { not: string }).not : false))) return false;
    if (where.id && r.id !== where.id) return false;
    return true;
  };
  const prisma = {
    deployment: {
      findMany: jest.fn(async (a: { where: Record<string, unknown> }) => rows.filter((r) => match(r, a.where)).map((r) => ({ ...r }))),
      findUnique: jest.fn(async (a: { where: { id: string } }) => rows.find((r) => r.id === a.where.id) ?? null),
      updateMany: jest.fn(async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => match(r, a.where));
        for (const r of hit) Object.assign(r, a.data);
        return { count: hit.length };
      }),
    },
  };
  const agentWs = {
    isOnline: jest.fn((s: string) => online.has(s)),
    agentSupports: jest.fn((s: string, f: string) => online.has(s) && feats.has(f)),
    adoptCommand: opts.adopt ?? jest.fn().mockResolvedValue({ kind: "result", exitCode: 0, output: "ok", killed: false }),
  };
  const apps = { setLeaseReleasedHook: jest.fn(), finalizeAdopted: jest.fn().mockResolvedValue(undefined), settleInterrupted: jest.fn().mockResolvedValue(true) };
  const deployLogs = { begin: jest.fn(), push: jest.fn() };
  const svc = new DeployRecoveryService(prisma as never, agentWs as never, apps as never, { bootId: BOOT } as never, deployLogs as never);
  return { svc, prisma, agentWs, apps, deployLogs, rows };
}

describe("DeployRecoveryService", () => {
  it("adoptForServer adopts only that server's recoverable rows: CAS-claims (ownerId ← us), asks the agent, finalizes with the FRESH row", async () => {
    const m = make([row(), row({ id: "d2", agentServerId: "s2" }), row({ id: "d3", phase: "CLAIMED", agentReqId: null })]);
    await m.svc.adoptForServer("s1");
    expect(m.agentWs.adoptCommand).toHaveBeenCalledTimes(1);
    expect(m.agentWs.adoptCommand).toHaveBeenCalledWith("s1", "dep-d1", expect.any(Function), expect.any(Number));
    const claim = m.prisma.deployment.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: "d1", status: "RUNNING", phase: { in: ["DISPATCHED", "RECOVERING"] }, ownerId: "boot-old" });
    expect(claim.data).toMatchObject({ ownerId: BOOT, phase: "DISPATCHED" });
    expect(m.apps.finalizeAdopted).toHaveBeenCalledWith(expect.objectContaining({ id: "d1", ownerId: BOOT }), { kind: "result", exitCode: 0, output: "ok", killed: false });
    expect(m.deployLogs.begin).toHaveBeenCalledWith("app1");
    expect(m.apps.settleInterrupted).not.toHaveBeenCalled();
  });

  it("a released row (ownerId NULL) is adoptable; a row WE already own is not (no double adoption)", async () => {
    const m = make([row({ ownerId: null, phase: "RECOVERING" }), row({ id: "d2", ownerId: BOOT })]);
    await m.svc.adoptForServer("s1");
    expect(m.agentWs.adoptCommand).toHaveBeenCalledTimes(1);
    expect(m.agentWs.adoptCommand).toHaveBeenCalledWith("s1", "dep-d1", expect.any(Function), expect.any(Number));
  });

  it("CAS loser (row settled / claimed meanwhile) asks nothing", async () => {
    const m = make([row()]);
    m.prisma.deployment.updateMany.mockResolvedValueOnce({ count: 0 });
    await m.svc.adoptForServer("s1");
    expect(m.agentWs.adoptCommand).not.toHaveBeenCalled();
    expect(m.apps.finalizeAdopted).not.toHaveBeenCalled();
  });

  it("interrupted / unknown / no_reply settle as interrupted with a specific detail — never a fabricated result", async () => {
    for (const [kind, detail] of [
      ["interrupted", /agent restarted/],
      ["unknown", /no record/],
      ["no_reply", /did not report/],
    ] as const) {
      const m = make([row()], { adopt: jest.fn().mockResolvedValue({ kind, output: "p" }) });
      await m.svc.adoptForServer("s1");
      expect(m.apps.finalizeAdopted).not.toHaveBeenCalled();
      expect(m.apps.settleInterrupted).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }), expect.stringMatching(detail));
    }
  });

  it("the agent drops again while we wait: the lease is released (RECOVERING, ownerId null), nothing is settled", async () => {
    const m = make([row()], { adopt: jest.fn().mockRejectedValue(new AgentDisconnectedException()) });
    await m.svc.adoptForServer("s1");
    expect(m.rows[0]).toMatchObject({ status: "RUNNING", ownerId: null, phase: "RECOVERING" });
    expect(m.apps.settleInterrupted).not.toHaveBeenCalled();
    expect(m.apps.finalizeAdopted).not.toHaveBeenCalled();
    // ...and the next reconnect can adopt it again
    m.agentWs.adoptCommand.mockResolvedValue({ kind: "result", exitCode: 0, output: "ok", killed: false });
    await m.svc.adoptForServer("s1");
    expect(m.apps.finalizeAdopted).toHaveBeenCalledTimes(1);
  });

  it("offline agent: untouched (waits for the reconnect); an agent WITHOUT a journal: settled as interrupted without asking", async () => {
    const off = make([row()], { online: [] });
    await off.svc.adoptForServer("s1");
    expect(off.agentWs.adoptCommand).not.toHaveBeenCalled();
    expect(off.rows[0]).toMatchObject({ ownerId: "boot-old", phase: "DISPATCHED" });
    const legacy = make([row()], { features: [] });
    await legacy.svc.adoptForServer("s1");
    expect(legacy.agentWs.adoptCommand).not.toHaveBeenCalled();
    expect(legacy.apps.settleInterrupted).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }), expect.stringMatching(/does not keep a command journal/));
  });

  it("journal first: a row past its deadline whose agent is ONLINE is still asked (the journal keeps the real result); only an OFFLINE agent past the deadline is settled as interrupted", async () => {
    const m = make([row({ deadlineAt: new Date(NOW - 1) }), row({ id: "d2", agentServerId: "s9", deadlineAt: new Date(NOW - 1) }), row({ id: "d3", agentServerId: "s9", deadlineAt: new Date(NOW + 60_000) })]);
    await m.svc.sweep();
    expect(m.agentWs.adoptCommand).toHaveBeenCalledTimes(1); // d1: online + past deadline → asked (10s floor)
    expect(m.agentWs.adoptCommand).toHaveBeenCalledWith("s1", "dep-d1", expect.any(Function), 10_000);
    expect(m.apps.finalizeAdopted).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }), expect.anything());
    expect(m.apps.settleInterrupted).toHaveBeenCalledTimes(1); // d2: offline + past deadline
    expect(m.apps.settleInterrupted).toHaveBeenCalledWith(expect.objectContaining({ id: "d2" }), expect.stringMatching(/deadline passed/));
    expect(m.rows[2]).toMatchObject({ status: "RUNNING", phase: "DISPATCHED" }); // d3: offline, still in time → wait
  });

  it("adoptions run concurrently: a slow one never blocks the others or the caller's return", async () => {
    let release!: () => void;
    const slow = new Promise<{ kind: string }>((r) => (release = () => r({ kind: "unknown" })));
    const adopt = jest.fn().mockImplementation((_s: string, reqId: string) => (reqId === "dep-slow" ? slow : Promise.resolve({ kind: "result", exitCode: 0, output: "", killed: false })));
    const m = make([row({ id: "slow", agentReqId: "dep-slow" }), row({ id: "fast", agentReqId: "dep-fast" })], { adopt });
    let returned = false;
    const p = m.svc.adoptForServer("s1").then(() => (returned = true));
    await new Promise((r) => setImmediate(r));
    expect(adopt).toHaveBeenCalledTimes(2); // both claimed and asked at once
    expect(m.apps.finalizeAdopted).toHaveBeenCalledWith(expect.objectContaining({ id: "fast" }), expect.anything());
    expect(returned).toBe(false);
    release();
    await p;
    expect(m.apps.settleInterrupted).toHaveBeenCalledWith(expect.objectContaining({ id: "slow" }), expect.any(String));
  });

  it("the remaining window handed to adoptCommand is bounded by deadlineAt (with a floor)", async () => {
    const m = make([row({ deadlineAt: new Date(NOW + 30_000) })]);
    await m.svc.adoptForServer("s1");
    const ms = m.agentWs.adoptCommand.mock.calls[0][3] as number;
    expect(ms).toBeGreaterThan(10_000);
    expect(ms).toBeLessThanOrEqual(30_000);
    const tiny = make([row({ deadlineAt: new Date(NOW + 2_000) })]);
    await tiny.svc.adoptForServer("s1");
    expect(tiny.agentWs.adoptCommand.mock.calls[0][3]).toBe(10_000);
  });

  it("registers the lease-released hook with the applications service and does not start a ticker under NODE_ENV=test", () => {
    const m = make([]);
    m.svc.onModuleInit();
    expect(m.apps.setLeaseReleasedHook).toHaveBeenCalledWith(expect.any(Function));
    m.svc.onApplicationBootstrap();
    expect((m.svc as unknown as { timer?: unknown }).timer).toBeUndefined();
    m.svc.onModuleDestroy();
  });
});

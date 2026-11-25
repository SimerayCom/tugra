import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { CoolifyInPlaceService } from "../../../coolify-inplace/coolify-inplace.service";
import { Box, H, type BoxApp } from "../../../coolify-inplace/inplace-box";
import type { RunSnapshot, StepContext, StepSnapshot } from "../../core/run-contract";
import { RunLeaseLostError, StepFailure, EMPTY_STEP_EVIDENCE } from "../../core/run-contract";
import { InPlaceCutover } from "../cutover/inplace-cutover";
import { InPlaceRunSteps } from "./inplace-run.steps";
import { CUTOVER_FAILURE, INPLACE_RUN_CODES, inPlaceSuite, isInPlaceRun, refusalOf } from "./inplace-run-logic";
import { TAKEOVER_FAILURE_CODES } from "@tugra/shared";

const RUN = "run1";
const web: BoxApp = { appId: "appweb", itemRef: "app:s1:webuuid", name: "web", host: "web.example.com", ctrId: H("a"), ctrName: "webuuid-20261125T101010", image: "webuuid:aaa111" };
const data: BoxApp = { appId: "appdb", itemRef: "app:s1:dbuuid", name: "api", host: "api.example.com", ctrId: H("b"), ctrName: "dbuuid-20261125T101010", image: "dbuuid:bbb222", mounts: [{ type: "volume", source: "dbuuid-data", dest: "/data", rw: true }], volumes: [{ name: "data", path: "/data" }] };

/** The real takeover service over the fake box, with just enough of a table (rows by id, found by run id). */
function rig(o: { role?: Role | null; apps?: BoxApp[] } = {}) {
  const box = new Box();
  for (const a of o.apps ?? [web, data]) box.add(a);
  const rows = new Map<string, Record<string, unknown>>();
  let n = 0;
  const view = (r: Record<string, unknown>) => ({ ...r, createdAt: new Date(`2026-11-26T10:00:0${r.seq}Z`), finishedAt: null });
  const prisma = {
    coolifyTakeover: {
      create: jest.fn(async ({ data: d }: { data: Record<string, unknown> }) => {
        const id = `tk${(n += 1)}`;
        rows.set(id, JSON.parse(JSON.stringify({ id, seq: n, failureCode: null, tempPort: null, sessionId: null, runId: null, ...d })));
        return view(rows.get(id)!);
      }),
      update: jest.fn(async ({ where, data: d }: { where: { id: string }; data: Record<string, unknown> }) => {
        Object.assign(rows.get(where.id)!, JSON.parse(JSON.stringify(d)));
        return view(rows.get(where.id)!);
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (rows.has(where.id) ? view(rows.get(where.id)!) : null)),
      findFirst: jest.fn(async ({ where }: { where: { runId: string } }) => {
        const hit = [...rows.values()].filter((r) => r.runId === where.runId).sort((a, b) => (b.seq as number) - (a.seq as number))[0];
        return hit ? view(hit) : null;
      }),
      findMany: jest.fn(async () => []),
    },
  };
  const access = { teamRole: jest.fn(async () => (o.role === undefined ? Role.OWNER : o.role)) };
  const audit = { log: jest.fn(async () => undefined) };
  const svc = new CoolifyInPlaceService(prisma as never, access as never, audit as never, box);
  return { box, svc, rows, audit, access };
}

interface SwapRec {
  state: string;
  coolifyProxy: unknown;
  tugraProxyBindBefore: string;
  liveAt: Date | null;
}
function fakeWorld() {
  const swaps = new Map<string, SwapRec & { id: string; runId: string; serverId: string }>();
  return {
    swaps,
    getSwap: jest.fn(async (runId: string, serverId: string) => swaps.get(`${runId}:${serverId}`) ?? null),
    createSwap: jest.fn(async (runId: string, serverId: string, snap: unknown, bind: string) => {
      const r = { id: `sw${swaps.size + 1}`, runId, serverId, state: "PLANNED", coolifyProxy: snap, tugraProxyBindBefore: bind, liveAt: null };
      swaps.set(`${runId}:${serverId}`, r);
      return r;
    }),
    setSwapState: jest.fn(async (runId: string, serverId: string, from: readonly string[], to: string) => {
      const r = swaps.get(`${runId}:${serverId}`);
      if (!r || !from.includes(r.state)) return false;
      r.state = to;
      if (to === "LIVE") r.liveAt = new Date();
      return true;
    }),
  };
}

const step = (over: Partial<StepSnapshot> = {}): StepSnapshot => ({ key: "CUTOVER", status: "RUNNING", attempt: 1, gate: null, approval: null, inputHash: null, progress: null, compensation: null, evidence: EMPTY_STEP_EVIDENCE, wait: null, notBefore: null, ...over });

function ctxOf(over: { run?: Partial<RunSnapshot>; step?: Partial<StepSnapshot>; verify?: Partial<StepSnapshot>; now?: Date } = {}) {
  const comp: Record<string, unknown> = { ...(over.step?.compensation ?? {}) };
  const patches: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const clock = { now: over.now ?? new Date("2026-11-26T10:00:00Z") };
  const run = { id: RUN, teamId: "team1", actorId: "u1", targetServerId: "srv1", serverMap: {}, topology: "swap-proxy", inPlace: true, mode: "copy", opId: "op1", freezeStartedAt: null, freezeEndedAt: null, ponrAt: null, ...over.run } as unknown as RunSnapshot;
  const ctx = {
    run,
    step: step({ ...over.step, compensation: comp }),
    actor: { userId: "u1" },
    bootId: "b",
    trigger: "tick",
    dryRun: false,
    approval: null,
    signal: new AbortController().signal,
    targetServerIds: ["srv1"],
    now: () => clock.now,
    targetFor: () => "srv1",
    stepState: (k: string) => (k === "VERIFY" ? step({ key: "VERIFY", status: "PASSED", approval: { at: "2026-11-26T09:59:00Z", expiresAt: "2026-11-26T10:29:00Z", byUserId: "u1", boundHash: "x", acks: [], acceptDataRisk: false, confirmName: "olgu-box" } as never, ...over.verify }) : step()),
    assertLease: jest.fn(async () => undefined),
    emit: jest.fn(async (e: { code: string }) => void events.push(e.code)),
    setProgress: jest.fn(async () => undefined),
    recordCompensation: jest.fn(async (p: Record<string, unknown>) => void Object.assign(comp, p)),
    patchRun: jest.fn(async (p: Record<string, unknown>) => void patches.push(p)),
    markPonr: jest.fn(async () => new Date()),
  } as unknown as StepContext;
  return { ctx, comp, patches, events, clock };
}

function steps(r: ReturnType<typeof rig>) {
  const world = fakeWorld();
  const dark = new InPlaceRunSteps(r.svc);
  const cut = new InPlaceCutover(r.svc, world as never);
  return { dark, cut, world };
}

/** Runs the whole DEPLOY_DARK act (plan + test) and returns what the step would do. */
const prepare = (s: ReturnType<typeof steps>, c: ReturnType<typeof ctxOf>) => s.dark.act(c.ctx);

describe("isInPlaceRun", () => {
  it("needs both the campaign's flag and the same-machine swap topology", () => {
    expect(isInPlaceRun({ inPlace: true, topology: "swap-proxy" })).toBe(true);
    expect(isInPlaceRun({ inPlace: true, topology: "two-box" })).toBe(false);
    expect(isInPlaceRun({ inPlace: false, topology: "swap-proxy" })).toBe(false);
    expect(isInPlaceRun({ topology: "swap-proxy" })).toBe(false);
  });
});

describe("DEPLOY_DARK of an in-place run", () => {
  it("plans a takeover linked to the run (no data copy, no build) and tests it on the dark proxy", async () => {
    const r = rig();
    const s = steps(r);
    const c = ctxOf();
    expect(await prepare(s, c)).toEqual({ outcome: "done" });
    const row = [...r.rows.values()][0];
    expect(row.runId).toBe(RUN);
    expect(row.status).toBe("TESTING");
    expect(c.comp.inPlace).toBe(true);
    // the box never published a port and nothing was removed or copied: only Tugra's proxy started dark and images were tagged
    expect(r.box.proxyBinds).toEqual(["none"]);
    expect(r.box.scripts.some((x) => /docker (rm|rmi|volume rm|system prune|cp)\b/.test(x))).toBe(false);
    expect(s.dark.postGate(await s.dark.state(c.ctx)).passed).toBe(true);
  });
  it("the run's own hold on the server does not make the server busy, another holder does", async () => {
    const r = rig();
    const s = steps(r);
    await prepare(s, ctxOf());
    expect(r.box.busyExcept).toEqual([RUN]);
    const r2 = rig();
    r2.box.busy = true;
    await expect(prepare(steps(r2), ctxOf())).rejects.toMatchObject({ code: "deploy-dark.inplace-server-busy", retryable: true });
  });
  it("is the team owner's alone: another role fails with its own code and nothing reached the box", async () => {
    const r = rig({ role: Role.ADMIN });
    await expect(prepare(steps(r), ctxOf())).rejects.toMatchObject({ code: "deploy-dark.inplace-owner-only", retryable: false });
    expect(r.box.scripts).toEqual([]);
  });
  it("refuses with a code when the server is the Coolify control plane box", async () => {
    const r = rig();
    r.box.controlPlane = "ghcr.io/coollabsio/coolify:4.7.8";
    const err = await prepare(steps(r), ctxOf()).catch((e) => e);
    expect(err).toBeInstanceOf(StepFailure);
    expect(err.code).toBe("deploy-dark.inplace-refused");
    expect(err.params.reason).toBe("takeover-control-plane");
  });
  it("a domain that answers differently through Tugra fails the step, retryable, naming the host", async () => {
    const r = rig();
    r.box.differs.add("web.example.com");
    await expect(prepare(steps(r), ctxOf())).rejects.toMatchObject({ code: "deploy-dark.inplace-test-failed", params: { host: "web.example.com" }, retryable: true });
  });
  it("a probe that could not run fails retryably, never a pass", async () => {
    const r = rig();
    r.box.noCurl = true;
    await expect(prepare(steps(r), ctxOf())).rejects.toMatchObject({ code: "deploy-dark.inplace-probe-unavailable", retryable: true });
  });
  it("a retry after the owner fixed the app tests the same takeover again instead of planning a second one", async () => {
    const r = rig();
    const s = steps(r);
    r.box.differs.add("web.example.com");
    await prepare(s, ctxOf()).catch(() => undefined);
    r.box.differs.delete("web.example.com");
    expect(await prepare(s, ctxOf())).toEqual({ outcome: "done" });
    expect(r.rows.size).toBe(1);
  });
  it("a lost lease is never turned into a step failure", async () => {
    const r = rig();
    const c = ctxOf();
    (c.ctx.assertLease as jest.Mock).mockRejectedValueOnce(new RunLeaseLostError(RUN));
    await expect(prepare(steps(r), c)).rejects.toBeInstanceOf(RunLeaseLostError);
  });
  it("abort gives the server back: Tugra's proxy stops and Coolify serves as before; a second abort has nothing to do", async () => {
    const r = rig();
    const s = steps(r);
    const c = ctxOf();
    await prepare(s, c);
    expect(await s.dark.compensate(c.ctx, "abort")).toEqual({ outcome: "done" });
    expect(r.box.tugraProxy.published).toBe(false);
    expect(r.box.coolifyProxy.running).toBe(true);
    expect((await s.dark.state(c.ctx))?.status).toBe("GIVEN_BACK");
    expect(await s.dark.compensate(c.ctx, "abort")).toEqual({ outcome: "done" });
    expect(await s.dark.compensate(c.ctx, "cleanup")).toEqual({ outcome: "nothing-to-do" });
  });
  it("abort with no takeover ever planned has nothing to undo", async () => {
    const s = steps(rig());
    expect(await s.dark.compensate(ctxOf().ctx, "abort")).toEqual({ outcome: "nothing-to-do" });
  });
});

describe("VERIFY of an in-place run", () => {
  it("shows the dark test as the review: passing domains pass, an exclusive app is a warning, nothing blocks", async () => {
    const r = rig();
    const s = steps(r);
    const c = ctxOf();
    await prepare(s, c);
    const review = s.dark.review(await s.dark.state(c.ctx));
    expect(review.planHash).toBe("inplace:tk1");
    // every domain the takeover serves is named in the review, the exclusive app's too (it is only checked after the switch)
    expect(review.hosts).toEqual(["api.example.com", "web.example.com"]);
    expect(review.suite.map((x) => [x.code, x.status])).toEqual([
      ["verify.inplace-domain-checked", "pass"],
      ["verify.inplace-switched", "warn"],
    ]);
  });
  it("an app left out of the takeover that has a domain must be accepted by name; one without a domain only warns", () => {
    const suite = inPlaceSuite({
      id: "tk1",
      status: "TESTING",
      failureCode: null,
      items: [
        { itemRef: "app:s1:a", name: "lost", buildMode: "reuse-image", skipped: true, issues: ["volume_unmapped"], domains: [] },
        { itemRef: "app:s1:b", name: "worker", buildMode: "reuse-image", skipped: true, issues: ["no_domain"], domains: [] },
      ],
      gate: { ok: true },
      pending: 0,
      certWorkLeft: false,
      verified: false,
      proxy: {} as never,
      bindBefore: "public",
    });
    expect(suite.map((x) => [x.code, x.status, x.ackable ?? false])).toEqual([
      ["verify.inplace-app-left-out", "fail", true],
      ["verify.inplace-app-no-domain", "warn", false],
    ]);
  });
  it("a failed domain blocks and nobody may accept it; no takeover or a takeover past its test blocks too", () => {
    const base = { id: "tk1", failureCode: null, gate: { ok: false as const, code: "test_failed" as const }, pending: 0, certWorkLeft: false, verified: false, proxy: {} as never, bindBefore: "public" };
    const failed = inPlaceSuite({ ...base, status: "TESTING", items: [{ itemRef: "x", name: "web", buildMode: "reuse-image", domains: [{ host: "a.example.com", tempCheck: "failed", finalCheck: "pending", cert: "pending" }] }] });
    expect(failed.map((x) => [x.code, x.status, x.ackable ?? false])).toEqual([["verify.inplace-domain-failed", "fail", false]]);
    expect(inPlaceSuite(null).map((x) => x.code)).toEqual(["verify.inplace-no-takeover"]);
    expect(inPlaceSuite({ ...base, status: "SWAPPED", items: [] }).map((x) => x.code)).toEqual(["verify.inplace-not-tested"]);
  });
});

describe("CUTOVER of an in-place run", () => {
  async function ready() {
    const r = rig();
    const s = steps(r);
    await prepare(s, ctxOf());
    return { r, s };
  }
  const obsOf = async (s: ReturnType<typeof steps>, c: ReturnType<typeof ctxOf>) => ({ opId: "op1", servers: [{ serverId: "srv1", name: "olgu-box", acmeEmailOk: true }], swap: (await s.world.getSwap(RUN, "srv1")) as never, inPlace: await s.cut.state(c.ctx) });

  it("takes the ports after the approval, then waits for a new certificate per domain and ends VERIFIED; the swap record mirrors it", async () => {
    const { r, s } = await ready();
    const c = ctxOf();
    const pre = s.cut.preGate(c.ctx, await obsOf(s, c));
    expect(pre.passed).toBe(true);
    // first tick: the swap, then one verify pass that takes Coolify's fallback away and waits for the new certificate
    const res = await s.cut.act(c.ctx, await obsOf(s, c));
    expect(res.outcome).toBe("done");
    expect(r.box.tugraProxy).toEqual({ state: "running", published: true });
    expect(r.box.coolifyProxy.running).toBe(false);
    expect(r.box.leIssued.has("web.example.com")).toBe(true);
    expect((await s.world.getSwap(RUN, "srv1"))?.state).toBe("LIVE");
    expect(c.comp.inPlaceSwapAt).toBeDefined();
    expect(c.patches.map((p) => Object.keys(p)[0])).toEqual(["freezeStartedAt", "freezeEndedAt"]);
    expect(s.cut.postGate(await obsOf(s, c)).passed).toBe(true);
    // the swap went through the run's actor and never skipped the typed names: the run's approval was already given
    expect(r.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.swap", meta: expect.objectContaining({ runId: RUN }) }));
  });
  it("does not take the ports without a valid approval or without a passed test", async () => {
    const { s } = await ready();
    const noApproval = ctxOf({ verify: { status: "WAITING_APPROVAL", approval: null } });
    expect(s.cut.preGate(noApproval.ctx, await obsOf(s, noApproval)).passed).toBe(false);
    const expired = ctxOf({ now: new Date("2026-11-26T11:00:00Z") });
    const g = s.cut.preGate(expired.ctx, await obsOf(s, expired));
    expect(g.checks.find((x) => x.id === "cutover.approval")?.status).toBe("fail");
    const fresh = rig();
    const s2 = steps(fresh);
    const c = ctxOf();
    await expect(s2.cut.act(c.ctx, { opId: "op1", servers: [], swap: null, inPlace: null })).rejects.toMatchObject({ code: "cutover.inplace-not-tested" });
    expect(fresh.box.proxyBinds).toEqual([]);
  });
  it("needs the server's ACME email before Coolify's proxy is touched", async () => {
    const { s } = await ready();
    const c = ctxOf();
    const obs = { ...(await obsOf(s, c)), servers: [{ serverId: "srv1", name: "olgu-box", acmeEmailOk: false }] };
    const g = s.cut.preGate(c.ctx, obs);
    expect(g.passed).toBe(false);
    expect(g.checks.find((x) => x.id === "cutover.acme-email")?.ownerInput).toBe("acmeEmail");
  });
  it("a switch that fails before the ports change puts everything back and fails the step with the takeover's own code", async () => {
    const { r, s } = await ready();
    r.box.failProxyStop = true;
    const c = ctxOf();
    await expect(s.cut.act(c.ctx, await obsOf(s, c))).rejects.toMatchObject({ code: "cutover.inplace-swap-stop-failed", retryable: false });
    expect(r.box.coolifyProxy.running).toBe(true);
    expect((await s.world.getSwap(RUN, "srv1"))?.state).toBe("REVERSED");
  });
  it("a domain that fails its check after the switch keeps polling, then fails retryably naming the host once the window is over", async () => {
    const { r, s } = await ready();
    // api shares data with Coolify's copy, so it is only checked after the switch: make it answer differently then
    r.box.differs.add("api.example.com");
    const c = ctxOf();
    expect(await s.cut.act(c.ctx, await obsOf(s, c))).toEqual({ outcome: "continue", pollAfterMs: 15_000 });
    expect(c.patches.map((p) => Object.keys(p)[0])).toEqual(["freezeStartedAt"]); // the window of downtime is not closed while a domain fails
    const late = ctxOf({ now: new Date("2026-11-26T10:10:00Z"), step: { compensation: { inPlaceSwapAt: "2026-11-26T10:00:00Z" } } });
    await expect(s.cut.act(late.ctx, await obsOf(s, late))).rejects.toMatchObject({ code: "cutover.inplace-host-not-verified", params: { hosts: ["api.example.com"] }, retryable: true });
    // the step never reverses by itself: the server is still Tugra's until the owner decides
    expect(r.box.tugraProxy.published).toBe(true);
  });
  it("certificates that never come end in a retryable failure naming the domains once the attempts are used up", async () => {
    const { r, s } = await ready();
    r.box.leWorks = false;
    const c = ctxOf();
    let last: unknown;
    for (let i = 0; i < 4; i++) last = await s.cut.act(c.ctx, await obsOf(s, c)).catch((e) => e);
    expect(last).toBeInstanceOf(StepFailure);
    expect((last as StepFailure).code).toBe("cutover.inplace-certs-pending");
    expect((last as StepFailure).retryable).toBe(true);
    // Coolify's certificate was put back so the domain kept a valid one
    expect(r.box.fallback.has("web.example.com")).toBe(true);
  });
  it("reverse (and abort) give the server back with nothing lost: Coolify's containers and proxy run again and the swap record reads reversed", async () => {
    const { r, s } = await ready();
    const c = ctxOf();
    await s.cut.act(c.ctx, await obsOf(s, c));
    expect(await s.cut.compensate(c.ctx, "reverse")).toEqual({ outcome: "done" });
    expect(r.box.coolifyProxy.running).toBe(true);
    expect(r.box.tugraProxy.published).toBe(false);
    expect([...r.box.ctrs.values()].every((x) => x.running)).toBe(true);
    expect((await s.world.getSwap(RUN, "srv1"))?.state).toBe("REVERSED");
    expect(await s.cut.compensate(c.ctx, "abort")).toEqual({ outcome: "done" });
    expect(await s.cut.compensate(c.ctx, "cleanup")).toEqual({ outcome: "nothing-to-do" });
  });
  it("a give-back that cannot finish is a failed compensation (never a silent success)", async () => {
    const { r, s } = await ready();
    const c = ctxOf();
    await s.cut.act(c.ctx, await obsOf(s, c));
    r.box.status = "OFFLINE";
    const res = await s.cut.compensate(c.ctx, "reverse");
    expect(res.outcome).toBe("failed");
    expect(res.code).toBe("cutover.inplace-give-back-failed");
  });
  it("a swap that a crash left in the middle is reported, not guessed at", async () => {
    const { r, s } = await ready();
    const row = [...r.rows.values()][0];
    row.status = "SWAPPING";
    const c = ctxOf();
    await expect(s.cut.act(c.ctx, await obsOf(s, c))).rejects.toMatchObject({ code: "cutover.inplace-swap-interrupted", retryable: false });
  });
});

describe("codes", () => {
  it("every takeover failure has a cutover code and every code the in-place steps use is declared", () => {
    for (const f of TAKEOVER_FAILURE_CODES) expect(INPLACE_RUN_CODES).toContain(CUTOVER_FAILURE[f]);
    expect(new Set(INPLACE_RUN_CODES).size).toBe(INPLACE_RUN_CODES.length);
  });
  it("refusalOf maps HTTP refusals and leaves every other error to the caller", () => {
    expect(refusalOf("cutover", new ForbiddenException("x"))?.code).toBe("cutover.inplace-owner-only");
    expect(refusalOf("cutover", new ConflictException("takeover_server_busy"))).toMatchObject({ code: "cutover.inplace-server-busy", retryable: true });
    expect(refusalOf("cutover", new RunLeaseLostError("r"))).toBeNull();
    expect(refusalOf("cutover", new Error("boom"))).toBeNull();
  });
});

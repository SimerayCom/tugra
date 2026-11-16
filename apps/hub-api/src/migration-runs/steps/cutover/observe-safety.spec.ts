import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { AgentWsServer } from "../../../agent-gateway/agent-ws.server";
import { APPLICATIONS_SERVICE } from "../../../applications/applications.tokens";
import { AuditService } from "../../../audit/audit.service";
import { CutoverCertService } from "../../../cutover/cutover-cert.service";
import { CutoverService } from "../../../cutover/cutover.service";
import { NetProbe } from "../../../cutover/net-probe";
import { InstanceSettingsService } from "../../../instance/instance-settings.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { ProxyOpsService } from "../../../server-ops/proxy-ops.service";
import { StepRegistryModule } from "../../core/step-registry.module";
import { IMPORT_STEPS_PORT } from "../import/import-ports";
import { PostPonrRelease as Release } from "../import/baseline/post-ponr";
import { CutoverHandler } from "./cutover.handler";
import { CutoverPlanService } from "./cutover-plan.service";
import { CutoverWorld as World } from "./cutover-world.service";
import { DecommissionHandler } from "./decommission.handler";
import { DnsPrepareHandler } from "./dns-prepare.handler";
import { TlsPreissueHandler } from "./tls-preissue.handler";
import { H, makeRig, zoneRec, type Rig, type RigOpts } from "./testing/cutover-rig";
import { FinalizeHandler } from "./finalize.handler";
import { OBSERVE_CHECK_EVERY_MS, ObserveHandler } from "./observe.handler";
import { buildSourceBaseline } from "../import/baseline/source-health";
import type { PostPonrRelease, WorkerVerify } from "../import/baseline/post-ponr";
import type { CutoverWorld } from "./cutover-world.service";

beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const apps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, host: H(i + 1), hasData: false }));
const zoneFor = (n: number) => Array.from({ length: n }, (_, i) => zoneRec(`r${i + 1}`, H(i + 1)));

async function afterCutover(o: RigOpts = {}): Promise<Rig> {
  const rig = makeRig({ apps: apps(3), zone: zoneFor(3), ...o, options: { ttlPolicy: "skip-ack", ...(o.options ?? {}) } });
  await rig.driver.drive(rig.handlers.dns);
  await rig.driver.drive(rig.handlers.tls);
  rig.driver.setStep("VERIFY", { status: "PASSED" });
  rig.driver.approve("VERIFY", "d".repeat(64), { acceptDataRisk: true, expiresAt: null });
  expect((await rig.driver.drive(rig.handlers.cut, { between: () => rig.cutover.idle() })).status).toBe("PASSED");
  rig.driver.setStep("CUTOVER", { status: "PASSED" });
  return rig;
}

/** A release double that records what it was asked, so these specs test the hand-off, not the release itself (see post-ponr.spec). */
const fakeRelease = (undo = { changed: 0, failed: 0 }, workers: WorkerVerify | null = null) => {
  const run = jest.fn(async (_ctx?: unknown, _opts?: { retry?: boolean }) => ({ workersStarted: 1, workersFailed: 0, autoDeployRestored: 1 }));
  const undoFn = jest.fn(async () => undo);
  const verify = jest.fn(async () => workers);
  return { release: { run, undo: undoFn, verify } as unknown as PostPonrRelease, run, undo: undoFn, verify };
};
const observeWith = (rig: Rig, release?: PostPonrRelease) => new ObserveHandler(rig.registry, rig.cutover, rig.world as unknown as CutoverWorld, rig.net as never, release);

const BASELINE = buildSourceBaseline(
  [
    { kind: "app", ref: "a1", health: "exited", restartCount: 90001 },
    { kind: "app", ref: "a2", health: "healthy", restartCount: 0 },
    { kind: "app", ref: "a3", health: "unknown", restartCount: 2 },
  ],
  new Date("2026-11-20T08:00:00Z"),
);

describe("OBSERVE judged against the source (R28/R66)", () => {
  it("an app that was already failing at the source cannot fail the window; every other app still can", async () => {
    const rig = await afterCutover();
    rig.driver.run.sourceBaseline = BASELINE;
    const obs = observeWith(rig);
    await rig.driver.tick(obs);
    expect(rig.driver.events.find((e) => e.code === "observe.baseline-excluded")?.params).toEqual({ count: 1 });
    rig.world.crashes.push({ name: "tugra_a1", ts: new Date(rig.driver.now.getTime() + 1000) });
    rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
    expect((await rig.driver.tick(obs, "timer")).status).toBe("WAITING_TIMER"); // a1 crashing again is what the source did
    rig.world.crashes.push({ name: "tugra_a2", ts: new Date(rig.driver.now.getTime() + 1000) });
    rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
    expect((await rig.driver.tick(obs, "timer")).fail).toEqual({ code: "observe.crash-detected", params: { events: 1 }, retryable: true });
  });

  it("an app that was only unchecked at the source (no health check) gets no excuse", async () => {
    const rig = await afterCutover();
    rig.driver.run.sourceBaseline = BASELINE;
    const obs = observeWith(rig);
    await rig.driver.tick(obs);
    rig.world.crashes.push({ name: "tugra_a3", ts: new Date(rig.driver.now.getTime() + 1000) });
    rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
    expect((await rig.driver.tick(obs, "timer")).fail).toMatchObject({ code: "observe.crash-detected" });
  });

  it("with no baseline nothing is excluded and the watch is exactly what it was", async () => {
    const rig = await afterCutover();
    await rig.driver.tick(rig.handlers.obs);
    expect(rig.driver.eventCodes()).not.toContain("observe.baseline-excluded");
    rig.world.crashes.push({ name: "tugra_a1", ts: new Date(rig.driver.now.getTime() + 1000) });
    rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
    expect((await rig.driver.tick(rig.handlers.obs, "timer")).fail).toMatchObject({ code: "observe.crash-detected" });
  });

  it("the observation counts the same excluded set (crashes the post gate sees)", async () => {
    const rig = await afterCutover();
    rig.driver.run.sourceBaseline = BASELINE;
    const obs = observeWith(rig);
    await rig.driver.tick(obs);
    rig.world.crashes.push({ name: "tugra_a1", ts: new Date(rig.driver.now.getTime() + 1000) });
    const o = await obs.observe(rig.driver.contextFor("OBSERVE"));
    expect(o).toMatchObject({ crashes: 0, baselineExcluded: 1 });
  });
});

describe("OBSERVE and FINALIZE release what was held until after the point of no return", () => {
  it("OBSERVE releases once, when its window opens, and remembers it", async () => {
    const rig = await afterCutover();
    const f = fakeRelease();
    const obs = observeWith(rig, f.release);
    await rig.driver.tick(obs);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(rig.driver.rec("OBSERVE").compensation!.releasedAt).toBeDefined();
    rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
    await rig.driver.tick(obs, "timer");
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("a release that was refused (null) is asked again on the next pass", async () => {
    const rig = await afterCutover();
    const f = fakeRelease();
    f.run.mockResolvedValueOnce(null as never);
    const obs = observeWith(rig, f.release);
    await rig.driver.tick(obs);
    expect(rig.driver.rec("OBSERVE").compensation!.releasedAt).toBeUndefined();
    rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
    await rig.driver.tick(obs, "timer");
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(rig.driver.rec("OBSERVE").compensation!.releasedAt).toBeDefined();
  });

  it("a release that throws fails the step retryably instead of pretending the workers started", async () => {
    const rig = await afterCutover();
    const f = fakeRelease();
    f.run.mockRejectedValueOnce(new Error("agent offline"));
    const r = await rig.driver.tick(observeWith(rig, f.release));
    expect(r.status).toBe("FAILED");
  });

  it("with the window skipped (0 minutes) FINALIZE is the first chance and releases", async () => {
    const rig = await afterCutover({ options: { observeMinutes: 0 } });
    const f = fakeRelease();
    expect(rig.handlers.obs.applicable(rig.driver.run)).toBe(false);
    rig.driver.setStep("OBSERVE", { status: "SKIPPED" });
    const fin = new FinalizeHandler(rig.registry, rig.cutover, rig.world as unknown as CutoverWorld, f.release);
    expect((await rig.driver.drive(fin)).status).toBe("PASSED");
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("without a release (a world that has none) both steps behave exactly as before", async () => {
    const rig = await afterCutover();
    rig.driver.setStep("OBSERVE", { status: "PASSED" });
    expect((await rig.driver.drive(rig.handlers.fin)).status).toBe("PASSED");
  });

  it("a reverse hands back to the release: workers stop, push-to-deploy goes off", async () => {
    const rig = await afterCutover();
    const f = fakeRelease({ changed: 3, failed: 0 });
    const obs = observeWith(rig, f.release);
    expect(await rig.driver.compensate(obs, "reverse")).toEqual({ outcome: "done" });
    expect(f.undo).toHaveBeenCalledTimes(1);
    for (const how of ["abort", "cleanup"] as const) expect((await rig.driver.compensate(obs, how)).outcome).toBe("nothing-to-do");
    expect(f.undo).toHaveBeenCalledTimes(1);
  });

  it("a reverse that could not put everything back fails the compensation (retryable) with a count", async () => {
    const rig = await afterCutover();
    const f = fakeRelease({ changed: 1, failed: 2 });
    expect(await rig.driver.compensate(observeWith(rig, f.release), "reverse")).toEqual({ outcome: "failed", code: "observe.reverse-release-failed", params: { count: 2 } });
    const none = fakeRelease({ changed: 0, failed: 0 });
    expect((await rig.driver.compensate(observeWith(rig, none.release), "reverse")).outcome).toBe("nothing-to-do");
  });
});

describe("OBSERVE and FINALIZE check that the held workers came up (R26/C13)", () => {
  const verdict = (over: Partial<WorkerVerify> = {}): WorkerVerify => ({ total: 2, running: 2, starting: [], failed: [], failedAtSource: [], ...over });
  const WINDOW = 31 * 60_000;

  it("a worker that failed to start fails the window with its name, and says so as an event, instead of going on to FINALIZE", async () => {
    const rig = await afterCutover();
    const f = fakeRelease({ changed: 0, failed: 0 }, verdict({ running: 1, failed: ["queue-worker"] }));
    const r = await rig.driver.tick(observeWith(rig, f.release));
    expect(r.fail).toEqual({ code: "observe.workers-not-running", params: { count: 1, workers: ["queue-worker"] }, retryable: true });
    expect(rig.driver.events.filter((e) => e.code === "release.worker-failed").map((e) => e.params)).toEqual([{ name: "queue-worker" }]);
  });

  it("a worker that is still starting when the window is over keeps the step waiting, and the step passes once it runs", async () => {
    const rig = await afterCutover();
    const f = fakeRelease({ changed: 0, failed: 0 }, verdict({ running: 1, starting: ["mail-worker"] }));
    const obs = observeWith(rig, f.release);
    await rig.driver.tick(obs);
    rig.driver.advance(WINDOW);
    const waiting = await rig.driver.tick(obs, "timer");
    expect(waiting.status).toBe("WAITING_TIMER");
    expect(rig.driver.rec("OBSERVE").wait).toMatchObject({ kind: "timer", code: "observe.workers-starting", params: { count: 1, workers: ["mail-worker"] } });
    f.verify.mockResolvedValue(verdict());
    rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
    expect((await rig.driver.tick(obs, "timer")).status).toBe("PASSED");
  });

  it("without held workers (null) the window ends exactly as before", async () => {
    const rig = await afterCutover();
    const obs = observeWith(rig, fakeRelease().release);
    await rig.driver.tick(obs);
    rig.driver.advance(WINDOW);
    expect((await rig.driver.tick(obs, "timer")).status).toBe("PASSED");
  });

  it("a retry of the window starts the failed workers again; the first pass does not ask for a rebuild", async () => {
    const rig = await afterCutover();
    const f = fakeRelease({ changed: 0, failed: 0 }, verdict({ running: 1, failed: ["queue-worker"] }));
    const obs = observeWith(rig, f.release);
    await rig.driver.tick(obs);
    expect(f.run.mock.calls[0][1]).toEqual({ retry: false });
    f.verify.mockResolvedValue(verdict());
    await rig.driver.tick(obs, "retry");
    expect(f.run.mock.calls[1][1]).toEqual({ retry: true });
  });

  it("the post gate carries the workers' state: failed and starting fail it, running passes it", async () => {
    const rig = await afterCutover();
    const cases: Array<[WorkerVerify, string, string]> = [
      [verdict({ failed: ["w"] }), "fail", "observe.workers-not-running"],
      [verdict({ starting: ["w"] }), "fail", "observe.workers-starting"],
      [verdict(), "pass", "observe.workers-running"],
    ];
    for (const [w, status, code] of cases) {
      const f = fakeRelease({ changed: 0, failed: 0 }, w);
      const obs = observeWith(rig, f.release);
      rig.driver.rec("OBSERVE").compensation = { observeStartedAt: rig.driver.now.toISOString() };
      const o = await obs.observe(rig.driver.contextFor("OBSERVE"));
      expect(obs.postGate(rig.driver.contextFor("OBSERVE"), o).checks.find((c) => c.id === "observe.workers")).toMatchObject({ status, code });
    }
  });

  it("FINALIZE fails the close when a worker did not come up, warns while one is still starting, and passes otherwise", async () => {
    const rig = await afterCutover({ options: { observeMinutes: 0 } });
    rig.driver.setStep("OBSERVE", { status: "SKIPPED" });
    const at = async (w: WorkerVerify | null) => {
      const fin = new FinalizeHandler(rig.registry, rig.cutover, rig.world as unknown as CutoverWorld, fakeRelease({ changed: 0, failed: 0 }, w).release);
      const o = await fin.observe(rig.driver.contextFor("FINALIZE"));
      return fin.postGate(rig.driver.contextFor("FINALIZE"), o).checks.find((c) => c.id === "finalize.workers");
    };
    expect(await at(verdict({ failed: ["queue-worker"] }))).toMatchObject({ status: "fail", code: "finalize.workers-not-running", params: { count: 1, workers: ["queue-worker"] } });
    expect(await at(verdict({ starting: ["queue-worker"] }))).toMatchObject({ status: "warn", code: "finalize.workers-starting" });
    expect(await at(verdict())).toMatchObject({ status: "pass", code: "finalize.workers-running" });
    expect(await at(null)).toBeUndefined();
    expect(await at(verdict({ total: 0, running: 0 }))).toBeUndefined();
  });
});

describe("Nest wiring of the release", () => {
  it("injects the post-PONR release into OBSERVE, FINALIZE and TLS_PREISSUE when the import steps provide it", async () => {
    const mod = await Test.createTestingModule({
      imports: [StepRegistryModule],
      providers: [
        World,
        CutoverPlanService,
        DnsPrepareHandler,
        TlsPreissueHandler,
        CutoverHandler,
        ObserveHandler,
        FinalizeHandler,
        DecommissionHandler,
        Release,
        { provide: IMPORT_STEPS_PORT, useValue: {} },
        { provide: CutoverService, useValue: {} },
        { provide: CutoverCertService, useValue: {} },
        { provide: ProxyOpsService, useValue: {} },
        { provide: NetProbe, useValue: {} },
        { provide: APPLICATIONS_SERVICE, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: AgentWsServer, useValue: {} },
        { provide: InstanceSettingsService, useValue: {} },
        { provide: ConfigService, useValue: {} },
        { provide: AuditService, useValue: {} },
      ],
    }).compile();
    await mod.init();
    const release = mod.get(Release);
    expect((mod.get(ObserveHandler) as unknown as { release: unknown }).release).toBe(release);
    expect((mod.get(FinalizeHandler) as unknown as { release: unknown }).release).toBe(release);
    expect((mod.get(TlsPreissueHandler) as unknown as { release: unknown }).release).toBe(release);
    await mod.close();
  });
});

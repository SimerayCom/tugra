import { H, makeRig, zoneRec, type Rig, type RigOpts } from "./testing/cutover-rig";
import { Logger } from "@nestjs/common";
import { OBSERVE_CHECK_EVERY_MS, hostHealthy } from "./observe.handler";

beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const apps = (n: number, hasData = false) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, host: H(i + 1), hasData }));
const zoneFor = (n: number) => Array.from({ length: n }, (_, i) => zoneRec(`r${i + 1}`, H(i + 1)));

/** Two-box run whose CUTOVER passed (every host VERIFIED). */
async function afterCutover(o: RigOpts & { n?: number } = {}): Promise<Rig> {
  const n = o.n ?? 2;
  const rig = makeRig({ apps: apps(n), zone: zoneFor(n), ...o, options: { ttlPolicy: "skip-ack", ...(o.options ?? {}) } });
  await rig.driver.drive(rig.handlers.dns);
  await rig.driver.drive(rig.handlers.tls);
  rig.driver.setStep("VERIFY", { status: "PASSED" });
  rig.driver.approve("VERIFY", "d".repeat(64), { acceptDataRisk: true, expiresAt: null });
  expect((await rig.driver.drive(rig.handlers.cut, { between: () => rig.cutover.idle() })).status).toBe("PASSED");
  rig.driver.setStep("CUTOVER", { status: "PASSED" });
  return rig;
}

const observe = (rig: Rig, o: { maxTicks?: number; stopOnTimer?: boolean } = {}) => rig.driver.drive(rig.handlers.obs, o);

describe("OBSERVE", () => {
  it("is skipped when the window is 0 minutes", async () => {
    const rig = makeRig();
    expect(rig.handlers.obs.applicable(rig.driver.run)).toBe(true);
    expect(rig.handlers.obs.applicable({ ...rig.driver.run, options: { ...rig.driver.run.options, observeMinutes: 0 } })).toBe(false);
    rig.driver.run.options = { ...rig.driver.run.options, observeMinutes: 0 };
    expect((await rig.driver.tick(rig.handlers.obs)).status).toBe("SKIPPED");
  });

  it("needs CUTOVER to have passed", async () => {
    const rig = await afterCutover();
    rig.driver.setStep("CUTOVER", { status: "RUNNING" });
    const r = await rig.driver.tick(rig.handlers.obs);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks[0]).toMatchObject({ id: "observe.cutover-passed", status: "fail" });
  });

  it("opens the window, waits on a timer (re-checking every few minutes), and passes once it elapsed with the hosts still healthy", async () => {
    const rig = await afterCutover();
    const check = jest.spyOn(rig.cutover, "check");
    const first = await rig.driver.tick(rig.handlers.obs);
    expect(first.status).toBe("WAITING_TIMER");
    expect(first.wait).toMatchObject({ kind: "timer", code: "observe.window-open", params: { minutes: 30 } });
    const startedAt = new Date(rig.driver.rec("OBSERVE").compensation!.observeStartedAt as string);
    expect(new Date((first.wait as { notBefore: string }).notBefore).getTime()).toBe(startedAt.getTime() + OBSERVE_CHECK_EVERY_MS);
    expect(rig.driver.run.freezeEndedAt).toBeInstanceOf(Date);
    const r = await observe(rig);
    expect(r.status).toBe("PASSED");
    expect(rig.driver.now.getTime()).toBeGreaterThanOrEqual(startedAt.getTime() + 30 * 60_000);
    expect(check.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(rig.driver.eventCodes()).toContain("observe.started");
  });

  it("the window is as long as the option says", async () => {
    const rig = await afterCutover({ options: { observeMinutes: 90 } });
    const first = await rig.driver.tick(rig.handlers.obs);
    expect((first.wait as unknown as { params: { minutes: number } }).params.minutes).toBe(90);
    const r = await observe(rig);
    expect(r.status).toBe("PASSED");
    const startedAt = new Date(rig.driver.rec("OBSERVE").compensation!.observeStartedAt as string);
    expect(rig.driver.now.getTime() - startedAt.getTime()).toBeGreaterThanOrEqual(90 * 60_000);
  });

  it("a crash/OOM of one of the run's containers inside the window fails the step (retryable); earlier episodes and other containers do not count", async () => {
    const rig = await afterCutover();
    rig.world.crashes.push({ name: "tugra_a1", ts: new Date(rig.driver.now.getTime() - 3600_000) }); // before the window
    await rig.driver.tick(rig.handlers.obs);
    rig.world.crashes.push({ name: "tugra_someone-else", ts: new Date(rig.driver.now.getTime() + 1000) });
    rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
    expect((await rig.driver.tick(rig.handlers.obs, "timer")).status).toBe("WAITING_TIMER");
    rig.world.crashes.push({ name: "tugra_a2", ts: new Date(rig.driver.now.getTime() + 1000) });
    rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
    const r = await rig.driver.tick(rig.handlers.obs, "timer");
    expect(r.fail).toEqual({ code: "observe.crash-detected", params: { events: 1 }, retryable: true });
  });

  it("a host that lost its router/route behind the target fails the step with the host named", async () => {
    const rig = await afterCutover();
    await rig.driver.tick(rig.handlers.obs);
    rig.sim.traefik404 = true;
    rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
    const r = await rig.driver.tick(rig.handlers.obs, "timer");
    expect(r.fail).toMatchObject({ code: "observe.host-unhealthy", retryable: true, params: { hosts: [H(1), H(2)] } });
  });

  it("a retry opens a FRESH window", async () => {
    const rig = await afterCutover();
    await rig.driver.tick(rig.handlers.obs);
    const first = rig.driver.rec("OBSERVE").compensation!.observeStartedAt;
    rig.driver.advance(10 * 60_000);
    await rig.driver.tick(rig.handlers.obs, "retry");
    expect(rig.driver.rec("OBSERVE").compensation!.observeStartedAt).not.toBe(first);
  });

  it("the post gate is false before the window opened and never passes early", async () => {
    const rig = await afterCutover();
    expect((await rig.driver.postGateOf(rig.handlers.obs)).passed).toBe(false);
    await rig.driver.tick(rig.handlers.obs);
    rig.driver.advance(29 * 60_000);
    expect((await rig.driver.postGateOf(rig.handlers.obs)).passed).toBe(false);
    rig.driver.advance(2 * 60_000);
    expect((await rig.driver.postGateOf(rig.handlers.obs)).passed).toBe(true);
  });

  it("watching changes nothing, so every compensation is a no-op", async () => {
    const rig = await afterCutover();
    for (const how of ["abort", "cleanup", "reverse"] as const) expect((await rig.driver.compensate(rig.handlers.obs, how)).outcome).toBe("nothing-to-do");
  });

  it("dry run only states the window", async () => {
    const rig = makeRig({ run: { dryRun: true } });
    await rig.driver.tick(rig.handlers.obs);
    expect(rig.driver.rec("OBSERVE").progress!.dryRun).toEqual([{ code: "observe.dry.window", level: "info", params: { minutes: 30 } }]);
  });

  describe("swap-proxy", () => {
    const swapObserve = async () => {
      const rig = makeRig({ apps: apps(2, true), zone: zoneFor(2), run: { topology: "swap-proxy", mode: "takeover" } });
      rig.world.server.proxyBind = "none";
      rig.host.tugra = { status: "running", ports: [] };
      for (const h of [H(1), H(2)]) rig.host.dark.set(h, { verify: 0, status: 200, traefik404: false });
      await rig.driver.drive(rig.handlers.tls);
      rig.driver.setStep("VERIFY", { status: "PASSED" });
      rig.driver.approve("VERIFY", "d".repeat(64), { acceptDataRisk: true, expiresAt: null });
      expect((await rig.driver.drive(rig.handlers.cut)).status).toBe("PASSED");
      rig.driver.setStep("CUTOVER", { status: "PASSED" });
      return rig;
    };

    it("re-verifies through Tugra's proxy for the whole window and passes", async () => {
      const rig = await swapObserve();
      const r = await observe(rig);
      expect(r.status).toBe("PASSED");
      expect(rig.net.sslAt).toHaveBeenCalled();
    });

    it("a host that stops answering inside the window fails the step; the swap is NOT reversed by it", async () => {
      const rig = await swapObserve();
      await rig.driver.tick(rig.handlers.obs);
      rig.sim.httpStatus = 503;
      rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
      const r = await rig.driver.tick(rig.handlers.obs, "timer");
      expect(r.fail).toMatchObject({ code: "observe.host-unhealthy", retryable: true });
      expect(rig.host.log.some((l) => l.kind === "swap-reverse")).toBe(false);
    });
  });
});

describe("hostHealthy", () => {
  const base = { state: "VERIFIED", needsDeploy: false, certState: "ready", challenge: "dns01", dnsObserved: "target", dnsMode: "cloudflare" } as never;
  it("needs VERIFIED, a live router, a ready cert (or http01) and DNS at the target", () => {
    expect(hostHealthy(base)).toBe(true);
    expect(hostHealthy({ ...(base as object), needsDeploy: true } as never)).toBe(false);
    expect(hostHealthy({ ...(base as object), certState: "default-cert" } as never)).toBe(false);
    expect(hostHealthy({ ...(base as object), certState: "pending", challenge: "http01" } as never)).toBe(true);
    expect(hostHealthy({ ...(base as object), dnsObserved: "source" } as never)).toBe(false);
    expect(hostHealthy({ ...(base as object), dnsObserved: "proxied" } as never)).toBe(true);
    expect(hostHealthy({ ...(base as object), state: "SWITCHED" } as never)).toBe(false);
  });
});

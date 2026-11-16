import { Logger } from "@nestjs/common";
import type { SourceBaseline } from "../../core/dto";
import { buildSourceBaseline } from "../import/baseline/source-health";
import { PRE_EXISTING_REASON, appRefOfHost, excuseDarkVerdicts, excuseSwapVerify, excusedBoxHosts, excusedSwapHosts } from "./baseline-hosts";
import { OBSERVE_CHECK_EVERY_MS } from "./observe.handler";
import { H, makeRig, zoneRec, type Rig, type RigOpts } from "./testing/cutover-rig";

beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const baseline = (rows: Array<{ ref: string; health: "healthy" | "unhealthy" | "unknown" | "exited"; restarts?: number | null }>): SourceBaseline =>
  buildSourceBaseline(rows.map((r) => ({ kind: "app" as const, ref: r.ref, health: r.health, restartCount: r.restarts ?? 0 })), new Date("2026-11-20T08:00:00Z"));

const entries = [
  { hostname: "a.example.test", applicationId: "id-a", state: "VERIFIED", needsDeploy: true },
  { hostname: "b.example.test", applicationId: "id-b", state: "VERIFIED", needsDeploy: true },
];
const apps = [
  { appId: "id-a", itemRef: "app:_:a" },
  { appId: "id-b", itemRef: "app:_:b" },
];

describe("source health baseline on the CUTOVER side (R52), pure", () => {
  it("maps a hostname to the plan item of the app that serves it", () => {
    const of = appRefOfHost(entries, apps);
    expect(of("a.example.test")).toBe("app:_:a");
    expect(of("unknown.example.test")).toBeNull();
    expect(appRefOfHost(entries, [{ appId: "id-a", itemRef: null }])("a.example.test")).toBeNull();
  });

  it("excuses a swap host that fails on HEALTH when its app was already unhealthy at the source, and nothing else", () => {
    const verify = { "a.example.test": { ok: false, reason: "health-server-error" }, "b.example.test": { ok: false, reason: "health-server-error" } };
    const out = excuseSwapVerify(verify, baseline([{ ref: "a", health: "unhealthy" }, { ref: "b", health: "healthy" }]), entries, apps)!;
    expect(out["a.example.test"]).toEqual({ ok: true, reason: PRE_EXISTING_REASON });
    expect(out["b.example.test"]).toEqual({ ok: false, reason: "health-server-error" }); // a NEW failure still fails
    expect(excusedSwapHosts(out)).toEqual(["a.example.test"]);
  });

  it("a certificate failure and a probe error are never excused: the source's state says nothing about them", () => {
    const verify = { "a.example.test": { ok: false, reason: "cert-default-cert" }, "b.example.test": { ok: false, reason: "probe-error" } };
    const out = excuseSwapVerify(verify, baseline([{ ref: "a", health: "exited" }, { ref: "b", health: "exited" }]), entries, apps)!;
    expect(out).toEqual(verify);
  });

  it("no baseline, or an app the baseline never saw, excuses nothing (the same object comes back)", () => {
    const verify = { "a.example.test": { ok: false, reason: "health-unreachable" } };
    expect(excuseSwapVerify(verify, null, entries, apps)).toBe(verify);
    expect(excuseSwapVerify(verify, baseline([{ ref: "zzz", health: "unhealthy" }]), entries, apps)).toBe(verify);
    expect(excuseSwapVerify(null, baseline([{ ref: "a", health: "unhealthy" }]), entries, apps)).toBeNull();
  });

  it("a dark verdict with a valid certificate and a bad app counts ready only for a pre-existing host", () => {
    const bad = { tls: "ok" as const, health: "server-error" as const, ready: false };
    const out = excuseDarkVerdicts({ "a.example.test": bad, "b.example.test": bad, "c.example.test": { tls: "fail" as const, health: "ok" as const, ready: false } }, baseline([{ ref: "a", health: "unhealthy" }, { ref: "b", health: "healthy" }]), entries, apps)!;
    expect(out["a.example.test"]).toEqual({ ...bad, ready: true, preExisting: true });
    expect(out["b.example.test"]).toEqual(bad);
    expect(out["c.example.test"].ready).toBe(false);
  });

  it("a two-box host whose only fault is the router probe is excused when its app was degraded at the source", () => {
    expect([...excusedBoxHosts(entries, baseline([{ ref: "a", health: "unhealthy" }]), apps)]).toEqual(["a.example.test"]);
    expect([...excusedBoxHosts(entries, null, apps)]).toEqual([]);
    expect([...excusedBoxHosts([{ ...entries[0], state: "SWITCHED" }], baseline([{ ref: "a", health: "unhealthy" }]), apps)]).toEqual([]);
  });
});

// ───────────────────────────── through the real handlers ─────────────────────────────

const rigApps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, host: H(i + 1), hasData: true }));
const zoneFor = (n: number) => Array.from({ length: n }, (_, i) => zoneRec(`r${i + 1}`, H(i + 1)));

/** One host answers 503 through the Tugra proxy (the cutover and observe probes), the others 200. */
const failHost = (rig: Rig, bad: string[]) => {
  rig.net.httpAt.mockImplementation(async (_ip: string, h: string, op: { tls: boolean }) => ({ status: op.tls ? (bad.includes(h) ? 503 : 200) : 301, traefik404: false, location: op.tls ? null : "https://x/" }));
  for (const h of bad) rig.host.dark.set(h, { verify: 0, status: 503, traefik404: false });
};

const swapRig = (o: RigOpts = {}): Rig => {
  const rig = makeRig({ apps: rigApps(2), zone: zoneFor(2), ...o, run: { topology: "swap-proxy", mode: "takeover", ...(o.run ?? {}) } });
  rig.world.server.proxyBind = "none";
  rig.host.tugra = { status: "running", ports: [] };
  for (const h of [H(1), H(2)]) rig.host.dark.set(h, { verify: 0, status: 200, traefik404: false });
  return rig;
};

describe("TLS_PREISSUE dark health against the baseline", () => {
  it("a host whose app was already unhealthy at the source does not hold the certificate step back: ready with a pre-existing warning", async () => {
    const rig = swapRig();
    rig.driver.run.sourceBaseline = baseline([{ ref: "a1", health: "exited", restarts: 90_000 }, { ref: "a2", health: "healthy" }]);
    failHost(rig, [H(1)]);
    const r = await rig.driver.drive(rig.handlers.tls);
    expect(r.status).toBe("PASSED");
    expect(r.gate!.checks.find((c) => c.subject === H(1))).toMatchObject({ status: "warn", code: "tls-preissue.dark-pre-existing", evidence: "source-api-reported" });
    expect(r.gate!.checks.find((c) => c.subject === H(2))).toMatchObject({ status: "pass", code: "tls-preissue.host-ready" });
  });

  it("the same failure with a healthy source, or with no baseline, is a NEW failure and still fails", async () => {
    for (const b of [baseline([{ ref: "a1", health: "healthy" }]), null]) {
      const rig = swapRig();
      rig.driver.run.sourceBaseline = b;
      failHost(rig, [H(1)]);
      const r = await rig.driver.drive(rig.handlers.tls, { maxTicks: 120 });
      expect(r.fail?.code).toBe("tls-preissue.timeout");
      expect((await rig.driver.postGateOf(rig.handlers.tls)).checks.find((c) => c.subject === H(1))).toMatchObject({ status: "fail", code: "tls-preissue.dark-not-ready" });
    }
  });
});

describe("CUTOVER swap verification against the baseline", () => {
  const ready = async (rig: Rig) => {
    expect((await rig.driver.drive(rig.handlers.tls)).status).toBe("PASSED");
    rig.driver.setStep("VERIFY", { status: "PASSED" });
    rig.driver.approve("VERIFY", "d".repeat(64), { acceptDataRisk: true, expiresAt: null });
    rig.phase.current = "cutover";
  };
  const cut = (rig: Rig, o: { maxTicks?: number } = {}) => rig.driver.drive(rig.handlers.cut, { ...o, between: () => rig.cutover.idle() });

  it("a host that does not answer through Tugra but was already unhealthy at the source passes the cutover with a warning", async () => {
    const rig = swapRig();
    await ready(rig);
    rig.driver.run.sourceBaseline = baseline([{ ref: "a1", health: "unhealthy" }, { ref: "a2", health: "healthy" }]);
    failHost(rig, [H(1)]);
    const r = await cut(rig);
    expect(r.status).toBe("PASSED");
    expect(r.gate!.checks.find((c) => c.subject === H(1))).toMatchObject({ status: "warn", code: "cutover.host-pre-existing" });
    expect(r.gate!.checks.find((c) => c.subject === H(2))).toMatchObject({ status: "pass", code: "cutover.host-verified" });
  });

  it("a NEW failure (healthy at the source) still fails the cutover verification", async () => {
    const rig = swapRig();
    await ready(rig);
    rig.driver.run.sourceBaseline = baseline([{ ref: "a1", health: "healthy" }, { ref: "a2", health: "unhealthy" }]);
    failHost(rig, [H(1)]);
    const r = await cut(rig, { maxTicks: 200 });
    expect(r.fail?.code).toBe("cutover.swap-verify-failed");
    expect(r.fail?.params).toMatchObject({ hosts: [H(1)] });
  });
});

describe("OBSERVE against the baseline", () => {
  const afterSwapCutover = async (): Promise<Rig> => {
    const rig = swapRig();
    expect((await rig.driver.drive(rig.handlers.tls)).status).toBe("PASSED");
    rig.driver.setStep("VERIFY", { status: "PASSED" });
    rig.driver.approve("VERIFY", "d".repeat(64), { acceptDataRisk: true, expiresAt: null });
    rig.phase.current = "cutover";
    expect((await rig.driver.drive(rig.handlers.cut, { between: () => rig.cutover.idle() })).status).toBe("PASSED");
    rig.driver.setStep("CUTOVER", { status: "PASSED" });
    return rig;
  };

  it("swap: a host that stops answering is a pre-existing warning when its app was degraded at the source, so the window passes", async () => {
    const rig = await afterSwapCutover();
    rig.driver.run.sourceBaseline = baseline([{ ref: "a1", health: "unhealthy" }, { ref: "a2", health: "healthy" }]);
    await rig.driver.tick(rig.handlers.obs);
    failHost(rig, [H(1)]);
    rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
    expect((await rig.driver.tick(rig.handlers.obs, "timer")).status).toBe("WAITING_TIMER");
    const r = await rig.driver.drive(rig.handlers.obs);
    expect(r.status).toBe("PASSED");
    expect(r.gate!.checks.find((c) => c.id === "observe.hosts-pre-existing")).toMatchObject({ status: "warn", code: "observe.host-pre-existing", params: { hosts: [H(1)] } });
  });

  it("swap: the same failure on a host that was healthy at the source fails the window", async () => {
    const rig = await afterSwapCutover();
    rig.driver.run.sourceBaseline = baseline([{ ref: "a1", health: "healthy" }, { ref: "a2", health: "unhealthy" }]);
    await rig.driver.tick(rig.handlers.obs);
    failHost(rig, [H(1)]);
    rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
    expect((await rig.driver.tick(rig.handlers.obs, "timer")).fail).toMatchObject({ code: "observe.host-unhealthy", params: { hosts: [H(1)] } });
  });

  it("two-box: a host that lost its router is excused only when its app was degraded at the source; the other host is still named", async () => {
    const rig = makeRig({ apps: rigApps(2), zone: zoneFor(2), options: { ttlPolicy: "skip-ack" } });
    await rig.driver.drive(rig.handlers.dns);
    await rig.driver.drive(rig.handlers.tls);
    rig.driver.setStep("VERIFY", { status: "PASSED" });
    rig.driver.approve("VERIFY", "d".repeat(64), { acceptDataRisk: true, expiresAt: null });
    expect((await rig.driver.drive(rig.handlers.cut, { between: () => rig.cutover.idle() })).status).toBe("PASSED");
    rig.driver.setStep("CUTOVER", { status: "PASSED" });
    rig.driver.run.sourceBaseline = baseline([{ ref: "a1", health: "unhealthy" }, { ref: "a2", health: "healthy" }]);
    await rig.driver.tick(rig.handlers.obs);
    rig.sim.traefik404 = true; // every host loses its route behind the target
    rig.driver.advance(OBSERVE_CHECK_EVERY_MS);
    expect((await rig.driver.tick(rig.handlers.obs, "timer")).fail).toMatchObject({ code: "observe.host-unhealthy", params: { hosts: [H(2)] } });
    // with both apps degraded at the source nothing fails
    rig.driver.run.sourceBaseline = baseline([{ ref: "a1", health: "unhealthy" }, { ref: "a2", health: "exited" }]);
    const r = await rig.driver.tick(rig.handlers.obs, "retry");
    expect(r.fail).toBeUndefined();
  });
});

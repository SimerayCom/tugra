import { Logger } from "@nestjs/common";
import type { AnyStepHandler } from "../../core/run-contract";
import { COOLIFY_ID, H, IP, OLD, makeRig, zoneRec, type Rig } from "./testing/cutover-rig";

beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const apps = (n: number, hasData: boolean) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, host: H(i + 1), hasData }));
const zoneFor = (n: number) => Array.from({ length: n }, (_, i) => zoneRec(`r${i + 1}`, H(i + 1)));
/** Events, gates, waits, progress and compensation of every step are codes + params: no token, key or credential may appear in them. */
function expectNoSecrets(rig: Rig) {
  const dump = JSON.stringify({ events: rig.driver.events, steps: [...rig.driver.steps.entries()] });
  expect(dump.length).toBeGreaterThan(100);
  expect(dump).not.toMatch(/tugra_mig_|CF_DNS_API_TOKEN|"TOK"|PRIVATE KEY|ops@realco\.io|Bearer /);
}

const settle = (rig: Rig, h: AnyStepHandler) => rig.driver.drive(h, { between: () => rig.cutover.idle() });

describe("lane C, the whole cutover side of a run", () => {
  it("copy + two-box: DNS_PREPARE, TLS_PREISSUE, CUTOVER, OBSERVE, FINALIZE in order; DECOMMISSION does not exist", async () => {
    const rig = makeRig({ apps: apps(2, true), zone: zoneFor(2) });
    const { dns, tls, cut, obs, fin, dec } = rig.handlers;
    expect((await settle(rig, dns)).status).toBe("PASSED");
    expect((await settle(rig, tls)).status).toBe("PASSED");
    // VERIFY (lane B) approved the plan 30 minutes ago
    rig.driver.setStep("VERIFY", { status: "PASSED" });
    rig.driver.approve("VERIFY", "d".repeat(64), { acceptDataRisk: true, expiresAt: new Date(rig.driver.now.getTime() + 3 * 3600_000).toISOString() });
    expect((await settle(rig, cut)).status).toBe("PASSED");
    rig.driver.setStep("CUTOVER", { status: "PASSED" });
    expect((await settle(rig, obs)).status).toBe("PASSED");
    rig.driver.setStep("OBSERVE", { status: "PASSED" });
    expect((await settle(rig, fin)).status).toBe("PASSED");
    expect(await rig.driver.tick(dec)).toMatchObject({ status: "SKIPPED" });

    expect(rig.zone.records.map((r) => [r.name, r.content, r.ttl])).toEqual([[H(1), IP, 3600], [H(2), IP, 3600]]);
    expect(rig.world.tokenActive).toBe(false);
    expect(rig.driver.run.ponrAt).not.toBeNull();
    expect(rig.driver.run.freezeEndedAt).toBeInstanceOf(Date);
    const order = rig.driver.eventCodes();
    expect(order.indexOf("run.ponr.reached")).toBeLessThan(order.indexOf("cutover.flip-started"));
    expect(order.indexOf("cutover.flip-started")).toBeLessThan(order.indexOf("observe.started"));
    expect(order.indexOf("observe.started")).toBeLessThan(order.indexOf("finalize.token-revoked"));
    // the TTL wait ran in the background: the flip was only gated on it, after the data steps
    expect(rig.writes.filter((w) => w.phase === "setup").map((w) => w.kind).every((k) => k === "patchDnsRecord")).toBe(true);
    expectNoSecrets(rig);
  });

  it("takeover + swap-proxy: no DNS write anywhere, Coolify's proxy stopped and kept, Coolify's containers stopped (not removed) at the end", async () => {
    const rig = makeRig({ apps: apps(2, true), zone: zoneFor(2), run: { topology: "swap-proxy", mode: "takeover", inputs: { sourceController: { value: "agent", source: "request", setBy: "user1", at: "2026-11-20T09:00:00Z" } } } });
    rig.world.server.proxyBind = "none";
    rig.host.tugra = { status: "running", ports: [] };
    for (const h of [H(1), H(2)]) rig.host.dark.set(h, { verify: 0, status: 200, traefik404: false });
    rig.host.sourceContainers = [{ id: "aaaaaaaaaaaa", name: "app-1", running: true }];
    const { dns, tls, cut, obs, fin, dec } = rig.handlers;
    expect(await rig.driver.tick(dns)).toMatchObject({ status: "SKIPPED" });
    expect((await settle(rig, tls)).status).toBe("PASSED");
    rig.driver.setStep("VERIFY", { status: "PASSED" });
    rig.driver.approve("VERIFY", "d".repeat(64), { acceptDataRisk: true, expiresAt: null });
    expect((await settle(rig, cut)).status).toBe("PASSED");
    rig.driver.setStep("CUTOVER", { status: "PASSED" });
    expect((await settle(rig, obs)).status).toBe("PASSED");
    rig.driver.setStep("OBSERVE", { status: "PASSED" });
    expect((await settle(rig, fin)).status).toBe("PASSED");
    rig.driver.setStep("FINALIZE", { status: "PASSED" });
    rig.driver.run.createdAt = new Date(rig.driver.now.getTime() - 100 * 3600_000);
    const w = await rig.driver.tick(dec);
    expect(w.status).toBe("WAITING_APPROVAL");
    rig.driver.approve("DECOMMISSION", (w.wait as unknown as { binding: { inputHash: string } }).binding.inputHash);
    expect((await settle(rig, dec)).status).toBe("PASSED");

    expect(rig.writes).toEqual([]);
    expect(rig.host.coolify).toMatchObject({ id: COOLIFY_ID, running: false, restart: "no" });
    expect(rig.host.sourceContainers.every((c) => !c.running)).toBe(true);
    const scripts = rig.host.log.map((l) => l.kind);
    expect(scripts).not.toContain("swap-reverse");
    expect(rig.world.server.proxyBind).toBe("public");
    expect(rig.world.tokenActive).toBe(false);
    expectNoSecrets(rig);
  });

  it("abort of a stateless two-box run walks the steps back: flip reverted, DNS-01 switched off, TTL restored; Coolify stays authoritative", async () => {
    const rig = makeRig({ apps: apps(2, false), zone: zoneFor(2), options: { ttlPolicy: "skip-ack" } });
    const { dns, tls, cut } = rig.handlers;
    await settle(rig, dns);
    await settle(rig, tls);
    rig.driver.setStep("VERIFY", { status: "PASSED" });
    rig.driver.approve("VERIFY", "d".repeat(64), { acceptDataRisk: false, expiresAt: null });
    expect((await settle(rig, cut)).status).toBe("PASSED");
    expect(rig.zone.records.map((r) => r.content)).toEqual([IP, IP]);
    // the engine compensates in reverse step order over the steps that ran
    for (const h of [cut, tls, dns]) expect(["done", "nothing-to-do"]).toContain((await rig.driver.compensate(h, "abort")).outcome);
    expect(rig.zone.records.map((r) => [r.content, r.ttl])).toEqual([[OLD, 3600], [OLD, 3600]]);
    expect(rig.prisma.__apps.get("a1")!.dnsChallenge).toBe(false);
    expect(rig.driver.run.ponrAt).toBeNull();
  });

  it("abort of a same-host swap that never started leaves Coolify's proxy exactly as it was", async () => {
    const rig = makeRig({ apps: apps(1, true), zone: zoneFor(1), run: { topology: "swap-proxy", mode: "takeover" } });
    rig.world.server.proxyBind = "none";
    rig.host.tugra = { status: "running", ports: [] };
    rig.host.dark.set(H(1), { verify: 0, status: 200, traefik404: false });
    await settle(rig, rig.handlers.tls);
    for (const h of [rig.handlers.cut, rig.handlers.tls]) await rig.driver.compensate(h, "abort");
    expect(rig.host.coolify).toMatchObject({ running: true, restart: "always" });
    expect(rig.host.log.map((l) => l.kind).filter((k) => k !== "dark-probe")).toEqual([]);
    expect(rig.writes).toEqual([]);
  });
});

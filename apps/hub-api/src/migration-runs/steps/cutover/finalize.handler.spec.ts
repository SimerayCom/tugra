import { Logger } from "@nestjs/common";
import { H, makeRig, zoneRec, type Rig, type RigOpts } from "./testing/cutover-rig";
import { Crash } from "./testing/step-driver";

beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const apps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, host: H(i + 1), hasData: true }));
const zoneFor = (n: number) => Array.from({ length: n }, (_, i) => zoneRec(`r${i + 1}`, H(i + 1)));

async function afterObserve(o: RigOpts = {}): Promise<Rig> {
  const rig = makeRig({ apps: apps(2), zone: zoneFor(2), ...o, options: { ttlPolicy: "skip-ack", ...(o.options ?? {}) } });
  const swap = rig.driver.run.topology === "swap-proxy";
  if (swap) {
    rig.world.server.proxyBind = "none";
    rig.host.tugra = { status: "running", ports: [] };
    for (const h of [H(1), H(2)]) rig.host.dark.set(h, { verify: 0, status: 200, traefik404: false });
  } else await rig.driver.drive(rig.handlers.dns);
  await rig.driver.drive(rig.handlers.tls);
  rig.driver.setStep("VERIFY", { status: "PASSED" });
  rig.driver.approve("VERIFY", "d".repeat(64), { acceptDataRisk: true, expiresAt: null });
  expect((await rig.driver.drive(rig.handlers.cut, { between: () => rig.cutover.idle() })).status).toBe("PASSED");
  rig.driver.setStep("CUTOVER", { status: "PASSED" });
  rig.driver.setStep("OBSERVE", { status: "PASSED" });
  return rig;
}

describe("FINALIZE", () => {
  it("restores the original TTL of every verified host, revokes the migration token and stamps the window end", async () => {
    const rig = await afterObserve();
    expect(rig.zone.records.map((r) => r.ttl)).toEqual([60, 60]);
    rig.driver.run.freezeEndedAt = null;
    const r = await rig.driver.drive(rig.handlers.fin);
    expect(r.status).toBe("PASSED");
    expect(rig.zone.records.map((x) => x.ttl)).toEqual([3600, 3600]);
    expect(rig.prisma.cutoverDomain.rows.every((x) => x.finalizedAt)).toBe(true);
    expect(rig.world.tokenActive).toBe(false);
    expect(rig.driver.eventCodes()).toEqual(expect.arrayContaining(["finalize.ttl-restored", "finalize.token-revoked"]));
    expect(rig.driver.run.freezeEndedAt).toBeInstanceOf(Date);
  });

  it("is idempotent: a second pass touches nothing", async () => {
    const rig = await afterObserve();
    await rig.driver.drive(rig.handlers.fin);
    const patches = rig.zone.calls.filter((c) => c.startsWith("patch:")).length;
    const r = await rig.driver.tick(rig.handlers.fin);
    expect(r.status).toBe("PASSED");
    expect(rig.driver.rec("FINALIZE").attempt).toBe(1);
    expect(rig.zone.calls.filter((c) => c.startsWith("patch:")).length).toBe(patches);
  });

  it("a crash between the TTL restore and the token revoke resumes without restoring twice", async () => {
    const rig = await afterObserve();
    rig.world.mutations = 0;
    rig.world.crashAt = { n: 1, methods: ["revokeMigrationToken"] };
    await expect(rig.driver.tick(rig.handlers.fin)).rejects.toBeInstanceOf(Crash);
    expect(rig.zone.records.map((x) => x.ttl)).toEqual([3600, 3600]);
    const patches = rig.zone.calls.filter((c) => c.startsWith("patch:")).length;
    rig.world.crashAt = null;
    expect((await rig.driver.drive(rig.handlers.fin)).status).toBe("PASSED");
    expect(rig.zone.calls.filter((c) => c.startsWith("patch:")).length).toBe(patches);
    expect(rig.world.tokenActive).toBe(false);
  });

  it("needs CUTOVER and OBSERVE behind it (a skipped OBSERVE counts)", async () => {
    const rig = await afterObserve();
    rig.driver.setStep("OBSERVE", { status: "RUNNING" });
    const r = await rig.driver.tick(rig.handlers.fin);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks.find((c) => c.id === "finalize.observe-passed")).toMatchObject({ status: "fail" });
    rig.driver.setStep("OBSERVE", { status: "SKIPPED" });
    expect((await rig.driver.drive(rig.handlers.fin)).status).toBe("PASSED");
  });

  it("manualFinalize waits for a typed approval bound to the verified hosts; a stale hash is void and nothing is finalized meanwhile", async () => {
    const rig = await afterObserve({ options: { manualFinalize: true } });
    const w = await rig.driver.tick(rig.handlers.fin);
    expect(w.status).toBe("WAITING_APPROVAL");
    const binding = (w.wait as unknown as { binding: { inputHash: string; confirm: string; ponr: boolean } }).binding;
    expect(binding).toMatchObject({ confirm: "run-id", ponr: false });
    expect(rig.zone.records.map((x) => x.ttl)).toEqual([60, 60]);
    rig.driver.approve("FINALIZE", "0".repeat(64));
    expect((await rig.driver.tick(rig.handlers.fin)).status).toBe("WAITING_APPROVAL");
    rig.driver.approve("FINALIZE", binding.inputHash);
    expect((await rig.driver.drive(rig.handlers.fin)).status).toBe("PASSED");
    expect(rig.zone.records.map((x) => x.ttl)).toEqual([3600, 3600]);
  });

  it("swap-proxy has no DNS to restore: only the token is revoked", async () => {
    const rig = await afterObserve({ run: { topology: "swap-proxy", mode: "takeover" } });
    const finalize = jest.spyOn(rig.cutover, "finalize");
    const r = await rig.driver.drive(rig.handlers.fin);
    expect(r.status).toBe("PASSED");
    expect(finalize).not.toHaveBeenCalled();
    expect(rig.world.tokenActive).toBe(false);
  });

  it("a token that is already gone still passes", async () => {
    const rig = await afterObserve();
    rig.world.tokenActive = false;
    const r = await rig.driver.drive(rig.handlers.fin);
    expect(r.status).toBe("PASSED");
    expect(rig.driver.eventCodes()).toContain("finalize.token-already-revoked");
  });

  it("it is irreversible and benign: every compensation is a no-op", async () => {
    const rig = await afterObserve();
    await rig.driver.drive(rig.handlers.fin);
    for (const how of ["abort", "cleanup", "reverse"] as const) expect((await rig.driver.compensate(rig.handlers.fin, how)).outcome).toBe("nothing-to-do");
    expect(rig.zone.records.map((x) => x.ttl)).toEqual([3600, 3600]);
  });

  it("dry run writes nothing", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1), run: { dryRun: true, options: undefined } });
    await rig.driver.tick(rig.handlers.fin);
    expect(rig.driver.rec("FINALIZE").progress!.dryRun!.map((i) => i.code)).toEqual(["finalize.dry.restore-ttl", "finalize.dry.revoke-token"]);
    expect(rig.world.tokenActive).toBe(true);
    expect(rig.writes).toEqual([]);
  });
});

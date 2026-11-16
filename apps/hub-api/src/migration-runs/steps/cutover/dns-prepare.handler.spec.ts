import { Crash } from "./testing/step-driver";
import { H, OLD, makeRig, zoneRec, type Rig } from "./testing/cutover-rig";

const apps = (n: number, hasData = false) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, host: H(i + 1), hasData }));
const zoneFor = (n: number) => Array.from({ length: n }, (_, i) => zoneRec(`r${i + 1}`, H(i + 1)));
const ttlOf = (rig: Rig, id: string) => rig.zone.records.find((r) => r.id === id)!.ttl;

afterEach(() => jest.useRealTimers());

describe("DNS_PREPARE", () => {
  it("is a two-box step only: a same-host swap changes no DNS record", () => {
    const rig = makeRig({ run: { topology: "swap-proxy" } });
    expect(rig.handlers.dns.applicable({ ...rig.driver.run, topology: "swap-proxy" })).toBe(false);
    expect(rig.handlers.dns.applicable({ ...rig.driver.run, topology: "two-box" })).toBe(true);
  });

  it("lowers the TTL right after IMPORT, passes immediately and records the TTL wait for the later steps", async () => {
    const rig = makeRig({ apps: apps(2), zone: zoneFor(2) });
    const r = await rig.driver.drive(rig.handlers.dns);
    expect(r.status).toBe("PASSED");
    expect(ttlOf(rig, "r1")).toBe(60);
    expect(ttlOf(rig, "r2")).toBe(60);
    const comp = rig.driver.rec("DNS_PREPARE").compensation!;
    expect(new Date(comp.ttlWaitUntil as string).getTime()).toBeGreaterThanOrEqual(rig.driver.now.getTime() + 3500_000);
    expect(rig.driver.eventCodes()).toEqual(expect.arrayContaining(["dns-prepare.ttl-lowered", "dns-prepare.ttl-wait"]));
    // the wait does NOT park the step: the data steps run while the old TTL expires
    expect(rig.driver.rec("DNS_PREPARE").status).toBe("PASSED");
  });

  it("writes only the TTL: no record is created, deleted or re-pointed", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1) });
    await rig.driver.drive(rig.handlers.dns);
    expect(rig.writes.map((w) => w.kind)).toEqual(["patchDnsRecord"]);
    expect(rig.zone.records[0]).toMatchObject({ content: OLD, ttl: 60 });
  });

  it("ttlPolicy skip-ack records no wait and says so", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1), options: { ttlPolicy: "skip-ack" } });
    await rig.driver.drive(rig.handlers.dns);
    expect(rig.driver.rec("DNS_PREPARE").compensation!.ttlWaitUntil).toBeNull();
    expect(rig.driver.eventCodes()).toContain("dns-prepare.ttl-wait-skipped");
  });

  it("a manual-DNS host gets guidance and nothing is written to any provider", async () => {
    const rig = makeRig({ apps: [{ id: "a1", host: "foo.other.net" }], zone: [] });
    const r = await rig.driver.drive(rig.handlers.dns);
    expect(r.status).toBe("PASSED");
    expect(rig.writes).toEqual([]);
    expect(rig.driver.rec("DNS_PREPARE").compensation!.manualHosts).toEqual(["foo.other.net"]);
    expect(rig.driver.eventCodes()).toContain("dns-prepare.manual-dns-guidance");
  });

  it("an op whose apps serve no hostname has nothing to prepare: the step passes without acting", async () => {
    const rig = makeRig({ apps: [{ id: "a1", host: "" }], zone: [] });
    rig.world.apps[0].domain = null;
    const r = await rig.driver.tick(rig.handlers.dns);
    expect(r.status).toBe("PASSED");
    expect(rig.driver.rec("DNS_PREPARE").attempt).toBe(0);
  });

  it("waits (operator) with a code when there is no import op yet", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1), run: { opId: null } });
    const r = await rig.driver.tick(rig.handlers.dns);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks[0]).toMatchObject({ id: "dns-prepare.import-op", status: "fail" });
  });

  it("a hub crash while lowering the TTLs converges on the same end state, each record lowered once", async () => {
    const rig = makeRig({ apps: apps(3), zone: zoneFor(3) });
    const orig = rig.cf.patchDnsRecord.getMockImplementation() as (...x: unknown[]) => Promise<never>;
    let n = 0;
    rig.cf.patchDnsRecord.mockImplementation((async (...a: unknown[]) => {
      if (++n === 2) throw new Crash("cf.patch#2");
      return orig(...a);
    }) as never);
    await expect(rig.driver.tick(rig.handlers.dns)).rejects.toBeInstanceOf(Crash);
    expect(rig.driver.rec("DNS_PREPARE").compensation).toMatchObject({ ttlRequestedAt: expect.any(String) });
    const r = await rig.driver.drive(rig.handlers.dns);
    expect(r.status).toBe("PASSED");
    expect([ttlOf(rig, "r1"), ttlOf(rig, "r2"), ttlOf(rig, "r3")]).toEqual([60, 60, 60]);
    // each record was patched exactly once (the crashed call never reached the zone)
    expect(rig.zone.calls.filter((c) => c.startsWith("patch:"))).toHaveLength(3);
  });

  it("abort puts the TTL back on a host that was never flipped, and is idempotent", async () => {
    const rig = makeRig({ apps: apps(2), zone: zoneFor(2) });
    await rig.driver.drive(rig.handlers.dns);
    expect(ttlOf(rig, "r1")).toBe(60);
    expect(await rig.driver.compensate(rig.handlers.dns, "abort")).toEqual({ outcome: "done" });
    expect(ttlOf(rig, "r1")).toBe(3600);
    expect(ttlOf(rig, "r2")).toBe(3600);
    expect(await rig.driver.compensate(rig.handlers.dns, "abort")).toEqual({ outcome: "nothing-to-do" });
  });

  it("cleanup and reverse have nothing to undo here", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1) });
    await rig.driver.drive(rig.handlers.dns);
    expect(await rig.driver.compensate(rig.handlers.dns, "cleanup")).toEqual({ outcome: "nothing-to-do" });
    expect(await rig.driver.compensate(rig.handlers.dns, "reverse")).toEqual({ outcome: "nothing-to-do" });
    expect(ttlOf(rig, "r1")).toBe(60);
  });

  it("dry run projects the hosts and writes nothing (no row, no provider call)", async () => {
    const rig = makeRig({ apps: apps(2), zone: zoneFor(2) });
    rig.driver.run.dryRun = true;
    const r = await rig.driver.tick(rig.handlers.dns);
    expect(r.status).toBe("PASSED");
    const items = rig.driver.rec("DNS_PREPARE").progress!.dryRun!;
    expect(items[0]).toMatchObject({ code: "dns-prepare.dry.would-lower-ttl", level: "info", params: { count: 2 } });
    expect(rig.prisma.cutoverDomain.rows).toHaveLength(0);
    expect(rig.writes).toEqual([]);
    expect(rig.cf.listDnsRecords).not.toHaveBeenCalled();
  });

  it("a dry run before IMPORT only says the hosts are known after it", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1), run: { opId: null, dryRun: true } });
    await rig.driver.tick(rig.handlers.dns);
    expect(rig.driver.rec("DNS_PREPARE").progress!.dryRun).toEqual([{ code: "dns-prepare.dry.hosts-after-import", level: "info" }]);
  });
});

import { H, makeRig, zoneRec, type Rig } from "./testing/cutover-rig";
import { CutoverPlanService } from "./cutover-plan.service";
import { cutoverPlanHash } from "./run-cutover-logic";

afterEach(() => jest.useRealTimers());

const apps = (n: number, hasData = false) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, host: H(i + 1), hasData }));
const zoneFor = (n: number) => Array.from({ length: n }, (_, i) => zoneRec(`r${i + 1}`, H(i + 1)));
const planOf = (rig: Rig) => new CutoverPlanService(rig.cutover, rig.world as never);
const runOf = (rig: Rig) => ({ id: "run1", opId: rig.driver.run.opId, actorId: "user1", topology: rig.driver.run.topology, targetServerId: "srv1" });

describe("CutoverPlanService (what VERIFY binds the PONR approval to)", () => {
  it("two-box: the flip plan hash plus the stateful hosts; stable until a host or a record changes", async () => {
    const rig = makeRig({ apps: apps(2, true), zone: zoneFor(2), options: { ttlPolicy: "skip-ack" } });
    await rig.driver.drive(rig.handlers.dns);
    await rig.driver.drive(rig.handlers.tls);
    const a = await planOf(rig).planHash(runOf(rig));
    const b = await planOf(rig).planHash(runOf(rig));
    expect(a).toEqual(b);
    expect(a!.statefulHosts).toEqual([H(1), H(2)]);
    expect(a!.planHash).toMatch(/^[a-f0-9]{64}$/);
    rig.zone.records[0].content = "192.0.2.50"; // provider drift since review
    const c = await planOf(rig).planHash(runOf(rig));
    expect(c!.planHash).not.toBe(a!.planHash);
    expect(rig.writes.filter((w) => w.phase !== "setup" && w.kind !== "patchDnsRecord")).toEqual([]);
  });

  it("two-box: a host that stops being READY changes the plan", async () => {
    const rig = makeRig({ apps: apps(2), zone: zoneFor(2), options: { ttlPolicy: "skip-ack" } });
    await rig.driver.drive(rig.handlers.dns);
    await rig.driver.drive(rig.handlers.tls);
    const a = await planOf(rig).planHash(runOf(rig));
    rig.prisma.cutoverDomain.rows[1].state = "CERT_PENDING";
    const b = await planOf(rig).planHash(runOf(rig));
    expect(b!.planHash).not.toBe(a!.planHash);
  });

  it("two-box with several target servers: ONE plan over every host (the flip then goes group by group)", async () => {
    const rig = makeRig({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: H(2), hasData: true, serverId: "srv-2" }], zone: zoneFor(2), options: { ttlPolicy: "skip-ack" }, run: { serverMap: { "source-b": "srv-2" } } });
    await rig.driver.drive(rig.handlers.dns);
    await rig.driver.drive(rig.handlers.tls);
    const a = await planOf(rig).planHash({ ...runOf(rig), serverMap: rig.driver.run.serverMap });
    expect(a!.statefulHosts).toEqual([H(2)]);
    expect(a!.planHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("swap-proxy over several target servers has no plan to approve; nor has a swap on the control plane's box", async () => {
    const rig = makeRig({ apps: apps(2, true), zone: zoneFor(2), run: { topology: "swap-proxy", mode: "takeover", serverMap: { "source-b": "srv-2" } } });
    expect(await planOf(rig).planHash({ ...runOf(rig), serverMap: { "source-b": "srv-2" } })).toBeNull();
    const single = makeRig({ apps: apps(2, true), zone: zoneFor(2), run: { topology: "swap-proxy", mode: "takeover" } });
    single.world.server.proxyBind = "none";
    single.host.tugra = { status: "running", ports: [] };
    for (const h of [H(1), H(2)]) single.host.dark.set(h, { verify: 0, status: 200, traefik404: false });
    await single.driver.drive(single.handlers.tls);
    expect(await planOf(single).planHash(runOf(single))).not.toBeNull();
    single.host.controlPlane = true;
    expect(await planOf(single).planHash(runOf(single))).toBeNull();
  });

  it("swap-proxy: bound to the exact source proxy and host list; nothing is written to the box", async () => {
    const rig = makeRig({ apps: apps(2, true), zone: zoneFor(2), run: { topology: "swap-proxy", mode: "takeover" } });
    rig.world.server.proxyBind = "none";
    rig.host.tugra = { status: "running", ports: [] };
    for (const h of [H(1), H(2)]) rig.host.dark.set(h, { verify: 0, status: 200, traefik404: false });
    await rig.driver.drive(rig.handlers.tls);
    const a = await planOf(rig).planHash(runOf(rig));
    expect(a!.statefulHosts).toEqual([H(1), H(2)]);
    expect(await planOf(rig).planHash(runOf(rig))).toEqual(a);
    rig.host.coolify!.image = "traefik:v3.2";
    expect((await planOf(rig).planHash(runOf(rig)))!.planHash).not.toBe(a!.planHash);
    expect(rig.host.log.every((l) => l.kind === "swap-inspect" || l.kind === "dark-probe")).toBe(true);
  });

  it("swap-proxy: an unreadable or mismatching source proxy gives no plan (so no approval can be bound)", async () => {
    const rig = makeRig({ apps: apps(1), zone: zoneFor(1), run: { topology: "swap-proxy", mode: "takeover" } });
    rig.world.server.proxyBind = "none";
    rig.host.tugra = { status: "running", ports: [] };
    rig.host.dark.set(H(1), { verify: 0, status: 200, traefik404: false });
    await rig.driver.drive(rig.handlers.tls);
    rig.host.coolify!.ports = ["80>80/tcp"];
    expect(await planOf(rig).planHash(runOf(rig))).toBeNull();
    rig.host.coolify = null;
    expect(await planOf(rig).planHash(runOf(rig))).toBeNull();
  });

  it("no import op yet: no plan", async () => {
    const rig = makeRig({ run: { opId: null } });
    expect(await planOf(rig).planHash({ ...runOf(rig), opId: null })).toBeNull();
  });

  it("cutoverPlanHash separates topologies and the stateful set, and ignores order", () => {
    const base = { topology: "two-box", planHash: "a".repeat(64), statefulHosts: ["b.example.com", "a.example.com"] };
    expect(cutoverPlanHash(base)).toBe(cutoverPlanHash({ ...base, statefulHosts: ["a.example.com", "b.example.com"] }));
    expect(cutoverPlanHash(base)).not.toBe(cutoverPlanHash({ ...base, topology: "swap-proxy" }));
    expect(cutoverPlanHash(base)).not.toBe(cutoverPlanHash({ ...base, statefulHosts: ["a.example.com"] }));
    expect(cutoverPlanHash(base)).not.toBe(cutoverPlanHash({ ...base, planHash: "b".repeat(64) }));
  });
});

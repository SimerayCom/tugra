import { Logger } from "@nestjs/common";
import { H, IP, OLD, makeRig, zoneRec, type Rig, type RigOpts } from "./testing/cutover-rig";
import { HTTP01_GAP_ATTEST, LEFT_OUT_ATTEST, MANUAL_DNS_ATTEST, MANUAL_DNS_DEFER_ATTEST, OBJECT_CLEARED_ATTEST } from "./cutover-holds";

/**
 * CUTOVER fitted to the shape of a real fleet (grup-7): objects-storage dependants, compose services as flippable hosts,
 * several target servers in one run, a long manual-DNS tail and per-host decisions that never stall the other hosts.
 * Names are invented (app-a, host-3, example.test); nothing here comes from a customer.
 */

beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const HASH = "d".repeat(64);
const input = (value: string) => ({ value, source: "request" as const, setBy: "user1", at: "2026-11-20T09:00:00Z" });
const zoneFor = (hosts: string[]) => hosts.map((h, i) => zoneRec(`r${i + 1}`, h));

type Ready = RigOpts & { policy?: string };

/** A rig whose DNS_PREPARE and TLS_PREISSUE passed (two-box) and whose VERIFY approval is in place. */
async function ready(o: Ready): Promise<Rig> {
  const run = { ...(o.run ?? {}), ...(o.policy ? { inputs: { minioPolicy: input(o.policy) } as never } : {}) };
  const rig = makeRig({ ...o, run, options: { ttlPolicy: "skip-ack", ...(o.options ?? {}) } });
  expect((await rig.driver.drive(rig.handlers.dns)).status).toBe("PASSED");
  expect((await rig.driver.drive(rig.handlers.tls)).status).toBe("PASSED");
  rig.driver.setStep("VERIFY", { status: "PASSED" });
  rig.driver.approve("VERIFY", HASH, { acceptDataRisk: true, expiresAt: new Date(rig.driver.now.getTime() + 3 * 3600_000).toISOString() });
  rig.phase.current = "cutover";
  return rig;
}

const drive = (rig: Rig, o: { maxTicks?: number } = {}) => rig.driver.drive(rig.handlers.cut, { ...o, between: () => rig.cutover.idle() });
const states = (rig: Rig) => Object.fromEntries(rig.prisma.cutoverDomain.rows.map((r) => [r.hostname as string, r.state as string]));
const flips = (rig: Rig, spy: jest.SpyInstance) => spy.mock.calls.map((c) => ({ hosts: (c[2] as { hostnames: string[] }).hostnames, autoRevert: (c[2] as { autoRevert: boolean }).autoRevert }));
const checkOf = (rig: Rig, code: string) => (rig.driver.rec("CUTOVER").gate?.checks ?? []).find((c) => c.code === code);

/**
 * The rows the web renders for the parked step (OperatorTools): one per attestation id of the CURRENT wait, one per gate check
 * of that id with its subject (a subject-less row when no check carries the id). The hub accepts only those ids, so a click
 * that is not in this list is refused; the subject of the attestation is the row's, never invented.
 */
const rows = (rig: Rig): Array<{ id: string; subject?: string }> => {
  const rec = rig.driver.rec("CUTOVER");
  const attest = rec.wait && rec.wait.kind === "operator" ? (rec.wait.attest ?? []) : [];
  return attest.flatMap((id) => {
    const subjects = (rec.gate?.checks ?? []).filter((c) => c.id === id).map((c) => c.subject);
    return (subjects.length > 0 ? subjects : [undefined]).map((subject) => ({ id, ...(subject ? { subject } : {}) }));
  });
};
const click = (rig: Rig, id: string, subject?: string): void => {
  expect(rows(rig)).toContainEqual({ id, ...(subject ? { subject } : {}) });
  rig.driver.attest("CUTOVER", id, subject);
};

/** A swap-proxy rig whose hosts were derived (TLS_PREISSUE on the dark proxy passed) and whose VERIFY approval is in place. */
const swapRig = async (o: RigOpts = {}): Promise<Rig> => {
  const rig = makeRig({ apps: [{ id: "a1", host: H(1), hasData: true }, { id: "a2", host: H(2), hasData: true }], zone: zoneFor([H(1), H(2)]), ...o, run: { topology: "swap-proxy", mode: "takeover", ...(o.run ?? {}) } });
  rig.world.server.proxyBind = "none";
  rig.host.tugra = { status: "running", ports: [] };
  for (const h of [H(1), H(2)]) rig.host.dark.set(h, { verify: 0, status: 200, traefik404: false });
  expect((await rig.driver.drive(rig.handlers.tls)).status).toBe("PASSED");
  rig.driver.setStep("VERIFY", { status: "PASSED" });
  rig.driver.approve("VERIFY", HASH, { acceptDataRisk: true, expiresAt: new Date(rig.driver.now.getTime() + 3 * 3600_000).toISOString() });
  rig.phase.current = "cutover";
  return rig;
};
describe("object storage (R34 / R61 / C7)", () => {
  const apps = [{ id: "a1", host: H(1) }, { id: "a2", host: H(2) }];
  const withKeys = (rig: Rig) => rig.world.objectKeys.set("a2", ["S3_ENDPOINT", "S3_BUCKET"]);

  it("policy hold (the default): only the dependant stays on the source, named with the input that unblocks it; the others flip and the step passes", async () => {
    const rig = await ready({ apps, zone: zoneFor([H(1), H(2)]) });
    withKeys(rig);
    const flip = jest.spyOn(rig.cutover, "flip");
    const first = await rig.driver.tick(rig.handlers.cut);
    expect(first.status).toBe("RUNNING");
    expect(checkOf(rig, "cutover.object-hold")).toMatchObject({ status: "warn", ownerInput: "minioPolicy", params: { hosts: [H(2)], count: 1 } });
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(flips(rig, flip)).toEqual([{ hosts: [H(1)], autoRevert: true }]);
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [H(2)]: "READY" });
    expect(rig.zone.records.find((x) => x.name === H(2))!.content).toBe(OLD);
    expect(r.gate!.checks.find((c) => c.subject === H(2))).toMatchObject({ status: "warn", code: "cutover.host-not-cut-over", params: { reason: "object-store-hold" } });
    expect(rig.driver.run.ponrAt).toBeNull();
  });

  it("policy mirror with unverified buckets: the dependant waits, the others are not held back, the wait names what releases it", async () => {
    const rig = await ready({ apps, zone: zoneFor([H(1), H(2)]), policy: "mirror" });
    withKeys(rig);
    const r = await drive(rig);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.wait).toMatchObject({ kind: "operator", code: "cutover.hosts-pending", params: { hosts: [H(2)], objects: [H(2)] }, attest: [OBJECT_CLEARED_ATTEST, LEFT_OUT_ATTEST] });
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [H(2)]: "READY" });
    expect(r.gate!.checks.find((c) => c.code === "cutover.objects-unverified")).toMatchObject({ status: "fail", params: { hosts: [H(2)] } });
  });

  it("an attestation for ONE host releases it; a subject-less one releases nothing", async () => {
    const rig = await ready({ apps, zone: zoneFor([H(1), H(2)]), policy: "mirror" });
    withKeys(rig);
    await drive(rig);
    rig.driver.attest("CUTOVER", OBJECT_CLEARED_ATTEST);
    expect((await drive(rig)).status).toBe("WAITING_OPERATOR");
    rig.driver.attest("CUTOVER", OBJECT_CLEARED_ATTEST, H(2));
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [H(2)]: "VERIFIED" });
  });

  it("policy mirror with every bucket verified: the dependant flips AFTER the others (its own, later group)", async () => {
    const rig = await ready({ apps, zone: zoneFor([H(1), H(2)]), policy: "mirror" });
    withKeys(rig);
    rig.world.objects = { attached: 1, selectedBuckets: 3, verified: 3, problems: 0 };
    const flip = jest.spyOn(rig.cutover, "flip");
    expect((await drive(rig)).status).toBe("PASSED");
    expect(flips(rig, flip).map((f) => f.hosts)).toEqual([[H(1)], [H(2)]]);
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [H(2)]: "VERIFIED" });
  });

  it("a bucket that differs keeps the dependant waiting", async () => {
    const rig = await ready({ apps, zone: zoneFor([H(1), H(2)]), policy: "mirror" });
    withKeys(rig);
    rig.world.objects = { attached: 1, selectedBuckets: 3, verified: 2, problems: 1 };
    expect((await drive(rig)).status).toBe("WAITING_OPERATOR");
    expect(states(rig)[H(2)]).toBe("READY");
  });

  it("policy external: nothing is held (no data moves, the apps keep the public endpoint)", async () => {
    const rig = await ready({ apps, zone: zoneFor([H(1), H(2)]), policy: "external" });
    withKeys(rig);
    const flip = jest.spyOn(rig.cutover, "flip");
    expect((await drive(rig)).status).toBe("PASSED");
    expect(flips(rig, flip)).toHaveLength(1);
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [H(2)]: "VERIFIED" });
  });

  it("an object-store service host is held with its dependants (it is the data the policy talks about)", async () => {
    const rig = await ready({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: H(2), service: true, status: "RUNNING", objectStore: true, hasData: true }], zone: zoneFor([H(1), H(2)]) });
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [H(2)]: "READY" });
    expect(r.gate!.checks.find((c) => c.subject === H(2))).toMatchObject({ code: "cutover.host-not-cut-over", params: { reason: "object-store-hold" } });
  });

  it("a host the operator leaves out is reported as not cut over and never flipped", async () => {
    const rig = await ready({ apps, zone: zoneFor([H(1), H(2)]), policy: "mirror" });
    withKeys(rig);
    await drive(rig);
    rig.driver.attest("CUTOVER", LEFT_OUT_ATTEST, H(2));
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(states(rig)[H(2)]).toBe("READY");
    expect(r.gate!.checks.find((c) => c.subject === H(2))).toMatchObject({ status: "warn", params: { reason: "host-left-out" } });
  });

  describe("a swap moves the whole box: a dependant cannot stay behind", () => {
    const gateOf = async (policy: string | null, objects?: { attached: number; selectedBuckets: number; verified: number; problems: number }) => {
      const rig = await swapRig({ apps, zone: zoneFor([H(1), H(2)]), ...(policy ? { run: { inputs: { minioPolicy: input(policy) } as never } } : {}) });
      rig.world.objectKeys.set("a2", ["S3_ENDPOINT"]);
      if (objects) rig.world.objects = objects;
      const r = await rig.driver.tick(rig.handlers.cut);
      return { rig, check: r.gate?.checks.find((c) => c.id === "cutover.object-dependants") };
    };

    it("hold (the default) refuses the swap, naming the dependants and the input that unblocks it", async () => {
      const { rig, check } = await gateOf(null);
      expect(check).toMatchObject({ status: "fail", code: "cutover.swap-object-hold", ownerInput: "minioPolicy", params: { hosts: [H(2)] } });
      expect(rig.host.log.map((l) => l.kind)).not.toContain("swap-stop-source");
      expect(rig.driver.run.ponrAt).toBeNull();
    });

    it("mirror refuses it until every selected bucket is verified", async () => {
      expect((await gateOf("mirror")).check).toMatchObject({ status: "fail", code: "cutover.objects-unverified" });
      expect((await gateOf("mirror", { attached: 1, selectedBuckets: 2, verified: 1, problems: 0 })).check).toMatchObject({ status: "fail" });
      expect((await gateOf("mirror", { attached: 1, selectedBuckets: 2, verified: 2, problems: 0 })).check).toBeUndefined();
    });

    it("external does not hold the swap", async () => {
      const { rig, check } = await gateOf("external");
      expect(check).toBeUndefined();
      expect(rig.driver.rec("CUTOVER").status).not.toBe("WAITING_OPERATOR");
    });
  });
});

describe("the env names are read sparingly", () => {
  it("the object-store env names are listed once per 30 seconds, not on every tick", async () => {
    const rig = await ready({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: H(2) }], zone: zoneFor([H(1), H(2)]), policy: "mirror" });
    const read = jest.spyOn(rig.world, "appObjectEnv");
    await rig.driver.tick(rig.handlers.cut);
    await rig.driver.tick(rig.handlers.cut);
    expect(read).toHaveBeenCalledTimes(1);
    await rig.driver.tick(rig.handlers.cut);
    expect(read).toHaveBeenCalledTimes(1);
    rig.driver.advance(31_000);
    await rig.driver.tick(rig.handlers.cut);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("compose services are flippable hosts (R13)", () => {
  it("a service host flips like any host once its service runs; until then only it waits", async () => {
    const rig = await ready({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: H(2), service: true, hasData: true }], zone: zoneFor([H(1), H(2)]) });
    // the real cutover service derived the service host from the import's service task
    expect(rig.prisma.cutoverDomain.rows.map((r) => r.hostname).sort()).toEqual([H(1), H(2)]);
    const first = await drive(rig);
    expect(first.status).toBe("WAITING_OPERATOR");
    expect(first.wait).toMatchObject({ code: "cutover.hosts-pending", params: { services: [H(2)] } });
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [H(2)]: "READY" });
    rig.world.apps[1].status = "RUNNING";
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(states(rig)).toMatchObject({ [H(2)]: "VERIFIED" });
    // a service with data volumes is stateful: the PONR is set before its flip
    expect(rig.driver.run.ponrAt).not.toBeNull();
  });
});

describe("several target servers in one run (C1)", () => {
  const apps = [
    { id: "a1", host: H(1) },
    { id: "a2", host: H(2), hasData: true, serverId: "srv-2" },
    { id: "a3", host: H(3), serverId: "srv-2" },
  ];
  const multi = (o: Ready = {}) => ready({ apps, zone: zoneFor([H(1), H(2), H(3)]), run: { serverMap: { "source-b": "srv-2" } }, ...o });

  it("flips one target server at a time, the stateless server first, with the PONR recorded ONCE before the first stateful write", async () => {
    const rig = await multi();
    const flip = jest.spyOn(rig.cutover, "flip");
    expect((await drive(rig)).status).toBe("PASSED");
    expect(flips(rig, flip)).toEqual([{ hosts: [H(1)], autoRevert: true }, { hosts: [H(2), H(3)], autoRevert: false }]);
    const ip2 = rig.prisma.__servers.get("srv-2")!.publicIp as string;
    expect(rig.zone.records.map((x) => [x.name, x.content])).toEqual([[H(1), IP], [H(2), ip2], [H(3), ip2]]);
    expect(rig.driver.events.filter((e) => e.code === "run.ponr.reached")).toHaveLength(1);
    const w = rig.writes.filter((x) => x.phase === "cutover");
    expect(w[0].ponr).toBe(false); // the stateless group flipped before any PONR
    expect(w.slice(1).every((x) => x.ponr)).toBe(true);
    expect(rig.driver.events.filter((e) => e.code === "cutover.flip-started").map((e) => (e.params as { server: string }).server)).toEqual(["target", "srv-2"]);
  });

  it("a group that has not verified stops the next group from starting", async () => {
    const rig = await multi();
    const flip = jest.spyOn(rig.cutover, "flip");
    const check = jest.spyOn(rig.cutover, "check");
    await rig.driver.tick(rig.handlers.cut); // group one starts
    await rig.cutover.idle();
    rig.prisma.cutoverDomain.rows.find((r) => r.hostname === H(1))!.state = "SWITCHED";
    rig.sim.propagated = false;
    const t = await rig.driver.tick(rig.handlers.cut);
    expect(t.status).toBe("RUNNING");
    expect(flip).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("user1", "op1", { hostnames: [H(1)] });
    expect(states(rig)[H(2)]).toBe("READY");
  });

  it("asks for an ACME email per server (a placeholder on ANY target server blocks, naming it)", async () => {
    const rig = await multi();
    rig.proxyConfig.resolveFor.mockImplementation((async (id: string) => ({ acmeEmail: id === "srv-2" ? "admin@example.com" : "ops@realco.io", bind: "public", dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "x" } })) as never);
    const r = await rig.driver.tick(rig.handlers.cut);
    expect(r.status).toBe("WAITING_OPERATOR");
    const mails = r.gate!.checks.filter((c) => c.id === "cutover.acme-email");
    expect(mails.map((c) => [c.subject, c.status])).toEqual([["target", "pass"], ["srv-2", "unknown"]]);
  });

  it("a multi-target run is refused for a proxy swap with a clear code, nothing touched", async () => {
    const rig = makeRig({ apps, zone: zoneFor([H(1), H(2), H(3)]), run: { topology: "swap-proxy", mode: "takeover", serverMap: { "source-b": "srv-2" } } });
    await rig.cutover.init("user1", "op1", {});
    rig.driver.setStep("VERIFY", { status: "PASSED" });
    rig.driver.approve("VERIFY", HASH, { acceptDataRisk: true });
    expect(await rig.plans.planHash({ ...rig.driver.run, actorId: "user1" })).toBeNull();
    const dry = await rig.handlers.cut.dryRun(rig.driver.contextFor("CUTOVER"));
    expect(dry.find((i) => i.code === "cutover.dry.swap-multi-target")).toMatchObject({ level: "block", params: { servers: 2 } });
    const r = await rig.driver.tick(rig.handlers.cut);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks.find((c) => c.code === "cutover.swap-multi-target")).toMatchObject({ status: "fail", params: { servers: 2 } });
    expect(rig.host.log.filter((l) => l.kind === "swap-stop-source")).toEqual([]);
    // and the step itself refuses before anything is touched, were it ever entered
    const refused = await rig.handlers.cut.act(rig.driver.contextFor("CUTOVER"), await rig.handlers.cut.observe(rig.driver.contextFor("CUTOVER"))).catch((e) => e);
    expect(refused).toMatchObject({ code: "cutover.swap-multi-target", retryable: false });
    expect(rig.driver.run.ponrAt).toBeNull();
  });

  it("the dry run projects the per-server flip", async () => {
    const rig = makeRig({ apps, zone: zoneFor([H(1), H(2), H(3)]), run: { dryRun: true, serverMap: { "source-b": "srv-2" } } });
    rig.world.objectKeys.set("a1", ["S3_ENDPOINT"]);
    rig.world.gitApps = [{ appId: "a1", name: "web", kind: "github-app", repo: "example.test/org/web", sourceId: "src1", autoDeploy: true }];
    const items = await rig.handlers.cut.dryRun(rig.driver.contextFor("CUTOVER"));
    expect(items.map((i) => i.code)).toEqual(expect.arrayContaining(["cutover.dry.flip-per-server", "cutover.dry.object-dependants", "cutover.dry.webhooks"]));
    expect(items.find((i) => i.code === "cutover.dry.object-dependants")).toMatchObject({ level: "warn", params: { apps: 1, policy: "hold" } });
  });
});

describe("manual DNS at scale (C10)", () => {
  const manual = ["m1.other.test", "m2.other.test", "m3.other.test"];
  const apps = [{ id: "a1", host: H(1) }, { id: "a2", host: manual[0], hasData: true }, { id: "a3", host: manual[1] }, { id: "a4", host: manual[2] }];
  const setup = () => ready({ apps, zone: zoneFor([H(1)]) });
  /** The resolvers answer with the target for these hosts. */
  const resolves = (rig: Rig, hosts: string[]) => {
    const orig = rig.lookup.resolve4.getMockImplementation()!;
    rig.lookup.resolve4.mockImplementation((async (h: string) => (hosts.includes(h) ? [IP] : orig(h))) as never);
  };

  it("gives ONE line per host with the exact records, after the provider host moved, with the PONR before the operator is told", async () => {
    const rig = await setup();
    const r = await drive(rig);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [manual[0]]: "READY", [manual[1]]: "READY", [manual[2]]: "READY" });
    expect(r.wait).toMatchObject({ code: "cutover.manual-dns", params: { hosts: manual, pending: 3, total: 3 }, attest: [MANUAL_DNS_ATTEST, MANUAL_DNS_DEFER_ATTEST] });
    expect(r.wait).toMatchObject({ params: { records: manual.map((h) => `${h} A ${IP} ttl=60`) } });
    expect(rig.driver.run.ponrAt).not.toBeNull();
    expect(rig.zone.records.some((x) => manual.includes(x.name))).toBe(false);
  });

  it("each host is confirmed and verified on its own while the step stays parked; deferring one leaves it on the source; the rest finish", async () => {
    const rig = await setup();
    await drive(rig);
    // host 1: confirmed, resolvers agree -> verified by the parked step's own observation, no act needed
    resolves(rig, [manual[0]]);
    rig.driver.attest("CUTOVER", MANUAL_DNS_ATTEST, manual[0]);
    rig.driver.advance(60_000);
    let t = await rig.driver.tick(rig.handlers.cut, "tick");
    expect(states(rig)[manual[0]]).toBe("VERIFIED");
    expect(t.status).toBe("WAITING_OPERATOR");
    expect(t.wait).toMatchObject({ code: "cutover.manual-dns", params: { hosts: [manual[1], manual[2]], pending: 2, total: 2 } });
    // host 3 is deferred (the customer cannot do it yet)
    rig.driver.attest("CUTOVER", MANUAL_DNS_DEFER_ATTEST, manual[2]);
    rig.driver.advance(60_000);
    t = await rig.driver.tick(rig.handlers.cut, "tick");
    expect(t.wait).toMatchObject({ params: { hosts: [manual[1]], pending: 1, total: 1 } });
    expect(rig.driver.rec("CUTOVER").gate!.checks.find((c) => c.code === "cutover.manual-dns-deferred")).toMatchObject({ status: "warn", params: { hosts: [manual[2]], count: 1 } });
    // host 2 is confirmed and shows up
    resolves(rig, [manual[0], manual[1]]);
    rig.driver.attest("CUTOVER", MANUAL_DNS_ATTEST, manual[1]);
    rig.driver.advance(60_000);
    const done = await rig.driver.drive(rig.handlers.cut, { between: () => rig.cutover.idle() });
    expect(done.status).toBe("PASSED");
    expect(states(rig)).toMatchObject({ [manual[0]]: "VERIFIED", [manual[1]]: "VERIFIED", [manual[2]]: "READY" });
    expect(done.gate!.checks.find((c) => c.subject === manual[2])).toMatchObject({ status: "warn", code: "cutover.host-not-cut-over", params: { reason: "manual-dns-deferred" } });
    // the hub never wrote a record for a manual host
    expect(rig.zone.records.some((x) => manual.includes(x.name))).toBe(false);
  });

  it("a confirmation the resolvers never back is asked about again, once per confirmation, and never fails the step", async () => {
    const rig = await setup();
    await drive(rig);
    rig.driver.attest("CUTOVER", MANUAL_DNS_ATTEST, manual[0]);
    rig.driver.attest("CUTOVER", MANUAL_DNS_DEFER_ATTEST, manual[1]);
    rig.driver.attest("CUTOVER", MANUAL_DNS_DEFER_ATTEST, manual[2]);
    const r = await rig.driver.drive(rig.handlers.cut, { maxTicks: 200, between: () => rig.cutover.idle() });
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.wait).toMatchObject({ code: "cutover.manual-dns", params: { hosts: [manual[0]] } });
    expect(rig.driver.events.filter((e) => e.code === "cutover.manual-dns-not-seen")).toHaveLength(1);
    await rig.driver.tick(rig.handlers.cut);
    expect(rig.driver.events.filter((e) => e.code === "cutover.manual-dns-not-seen")).toHaveLength(1);
  });

  it("a subject-less confirmation (the old single button) still covers every host", async () => {
    const rig = await setup();
    await drive(rig);
    resolves(rig, manual);
    rig.driver.attest("CUTOVER", MANUAL_DNS_ATTEST);
    const r = await rig.driver.drive(rig.handlers.cut, { between: () => rig.cutover.idle() });
    expect(r.status).toBe("PASSED");
    expect(states(rig)).toMatchObject({ [manual[0]]: "VERIFIED", [manual[1]]: "VERIFIED", [manual[2]]: "VERIFIED" });
  });
});

describe("decisions never hide behind each other", () => {
  it("a manual-DNS checklist also offers the release of a host that waits for its objects, and the release flips it", async () => {
    const rig = await ready({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: H(2) }, { id: "a3", host: "m1.other.test" }], zone: zoneFor([H(1), H(2)]), policy: "mirror" });
    rig.world.objectKeys.set("a2", ["S3_ENDPOINT"]);
    const r = await drive(rig);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.wait).toMatchObject({ code: "cutover.manual-dns", attest: [MANUAL_DNS_ATTEST, MANUAL_DNS_DEFER_ATTEST, OBJECT_CLEARED_ATTEST, LEFT_OUT_ATTEST] });
    expect(states(rig)[H(2)]).toBe("READY");
    rig.driver.attest("CUTOVER", OBJECT_CLEARED_ATTEST, H(2));
    await drive(rig);
    expect(states(rig)[H(2)]).toBe("VERIFIED");
  });

  it("a stateful host that stays on the source does not ask for the data-loss acknowledgement", async () => {
    const rig = await ready({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: H(2), hasData: true }], zone: zoneFor([H(1), H(2)]) });
    rig.world.objectKeys.set("a2", ["S3_ENDPOINT"]);
    rig.driver.approve("VERIFY", HASH, { acceptDataRisk: false, expiresAt: new Date(rig.driver.now.getTime() + 3 * 3600_000).toISOString() });
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(rig.driver.rec("CUTOVER").compensation).toBeTruthy();
    expect(rig.driver.run.ponrAt).toBeNull();
  });
});

describe("the HTTP-01 gap per host at CUTOVER (C10)", () => {
  it("only the host without an accepted gap waits; the others flip, and the waiting host is released by its own attestation", async () => {
    const rig = makeRig({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: H(2) }, { id: "a3", host: H(3) }], zone: zoneFor([H(1), H(2), H(3)]), options: { ttlPolicy: "skip-ack" } });
    rig.proxyConfig.resolveFor.mockResolvedValue({ acmeEmail: "ops@realco.io", bind: "public" } as never);
    rig.sim.sslOk = false;
    rig.driver.attest("TLS_PREISSUE", HTTP01_GAP_ATTEST, H(1));
    rig.driver.attest("TLS_PREISSUE", LEFT_OUT_ATTEST, H(3));
    expect((await rig.driver.drive(rig.handlers.dns)).status).toBe("PASSED");
    const asked = await rig.driver.drive(rig.handlers.tls, { maxTicks: 120 });
    expect(asked.status).toBe("WAITING_OPERATOR");
    expect(asked.wait).toMatchObject({ params: { hosts: [H(2)] } });
    rig.driver.attest("TLS_PREISSUE", HTTP01_GAP_ATTEST, H(2));
    expect((await rig.driver.drive(rig.handlers.tls)).status).toBe("PASSED");
    rig.driver.setStep("VERIFY", { status: "PASSED" });
    rig.driver.approve("VERIFY", HASH, { acceptDataRisk: true, expiresAt: new Date(rig.driver.now.getTime() + 3 * 3600_000).toISOString() });
    rig.phase.current = "cutover";
    // host 2's acceptance is not on record when CUTOVER runs (it was given to a different run of the step): it is held
    rig.driver.rec("TLS_PREISSUE").evidence.attestations = rig.driver.rec("TLS_PREISSUE").evidence.attestations.filter((a) => a.subject !== H(2));
    rig.sim.sslOk = true; // the certificate now arrives for a host that flips (the accepted gap host verifies)
    const flip = jest.spyOn(rig.cutover, "flip");
    const r = await drive(rig);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.wait).toMatchObject({ code: "cutover.hosts-pending", params: { hosts: [H(2)], gap: [H(2)] }, attest: [HTTP01_GAP_ATTEST, LEFT_OUT_ATTEST] });
    expect(flips(rig, flip)).toEqual([{ hosts: [H(1)], autoRevert: true }]);
    expect(flip.mock.calls[0][2]).toMatchObject({ acceptHttp01Gap: true });
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [H(2)]: "READY", [H(3)]: "READY" });
    rig.driver.attest("CUTOVER", HTTP01_GAP_ATTEST, H(2));
    const done = await drive(rig);
    expect(done.status).toBe("PASSED");
    expect(states(rig)).toMatchObject({ [H(2)]: "VERIFIED", [H(3)]: "READY" });
    expect(done.gate!.checks.find((c) => c.subject === H(3))).toMatchObject({ status: "warn", params: { reason: "host-left-out" } });
  });
});

describe("git webhook repoint after the cutover (R64)", () => {
  it("lists every git app behind a verified host as a warning, never a failure, and says it once", async () => {
    const rig = await ready({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: H(2) }], zone: zoneFor([H(1), H(2)]) });
    rig.world.gitApps = [
      { appId: "a1", name: "web", kind: "github-app", repo: "example.test/org/web", sourceId: "src1", autoDeploy: true },
      { appId: "a2", name: "api", kind: "deploy-token", repo: "example.test/org/web", sourceId: null, autoDeploy: false },
    ];
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    const warns = r.gate!.checks.filter((c) => c.code === "cutover.webhook-repoint");
    expect(warns.map((c) => [c.subject, c.status])).toEqual([["web", "warn"]]);
    expect(warns[0].params).toEqual({ repo: "example.test/org/web", autoDeploy: true, url: "https://hub.example.test/webhooks/github/src1" });
    expect(r.gate!.checks.filter((c) => c.code === "cutover.webhook-repoint-app").map((c) => [c.subject, c.status, c.params])).toEqual([["api", "warn", { repo: "example.test/org/web", autoDeploy: false }]]);
    const ev = rig.driver.events.filter((e) => e.code === "cutover.webhooks-repoint");
    expect(ev).toHaveLength(1);
    expect(ev[0].params).toEqual({ apps: 2, shared: 1, own: 1, sources: ["https://hub.example.test/webhooks/github/src1"], repos: ["example.test/org/web"] });
  });

  it("apps that all have their own deploy webhook get the per-app guidance and no shared URL", async () => {
    const rig = await ready({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: H(2) }], zone: zoneFor([H(1), H(2)]) });
    rig.world.gitApps = [
      { appId: "a1", name: "web", kind: "deploy-token", repo: "example.test/org/web", sourceId: null, autoDeploy: true },
      { appId: "a2", name: "api", kind: "deploy-token", repo: "example.test/org/api", sourceId: null, autoDeploy: false },
    ];
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(rig.driver.events.filter((e) => e.code === "cutover.webhooks-repoint")).toHaveLength(0);
    const ev = rig.driver.events.filter((e) => e.code === "cutover.webhooks-repoint-apps");
    expect(ev).toHaveLength(1);
    expect(ev[0].params).toEqual({ apps: 2, shared: 0, own: 2, repos: ["example.test/org/web", "example.test/org/api"] });
    expect(JSON.stringify(ev[0].params)).not.toContain("/webhooks/");
  });

  it("names no git app that has no verified host (a held host's app is repointed when it moves)", async () => {
    const rig = await ready({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: H(2) }], zone: zoneFor([H(1), H(2)]) });
    rig.world.objectKeys.set("a2", ["S3_ENDPOINT"]);
    rig.world.gitApps = [
      { appId: "a1", name: "web", kind: "github-app", repo: "example.test/org/web", sourceId: "src1", autoDeploy: true },
      { appId: "a2", name: "img", kind: "github-app", repo: "example.test/org/img", sourceId: "src1", autoDeploy: true },
    ];
    const r = await drive(rig);
    expect(r.gate!.checks.filter((c) => c.code === "cutover.webhook-repoint").map((c) => c.subject)).toEqual(["web"]);
  });
});

describe("the proxy swap on a shared control plane (C11)", () => {
  const kinds = (rig: Rig) => rig.host.log.map((l) => l.kind);

  it("refuses the box that runs the control plane: nothing is stopped, no swap row, no PONR, and the dry run says so", async () => {
    const rig = await swapRig();
    rig.host.controlPlane = true;
    const dry = await rig.handlers.cut.dryRun(rig.driver.contextFor("CUTOVER"));
    expect(dry.find((i) => i.code === "cutover.dry.swap-control-plane-host")).toMatchObject({ level: "block" });
    const r = await drive(rig);
    expect(r.status).toBe("FAILED");
    expect(r.fail).toMatchObject({ code: "cutover.swap-control-plane-host", retryable: false });
    expect(kinds(rig)).not.toContain("swap-stop-source");
    expect(rig.world.swaps.size).toBe(0);
    expect(rig.driver.run.ponrAt).toBeNull();
    expect(rig.host.coolify!.running).toBe(true);
    // and no approval can be bound to a swap that would be refused
    expect(await rig.plans.planHash({ ...rig.driver.run, actorId: "user1" })).toBeNull();
  });

  it("when Coolify brings its proxy back between the stop and Tugra's start, the box is taken back (stop again, start again); the control plane is never stopped", async () => {
    const rig = await swapRig();
    let comes = 1; // Coolify's health job wins the race once
    const start = rig.proxyOps.start.getMockImplementation() as unknown as (...a: unknown[]) => Promise<unknown>;
    rig.proxyOps.start.mockImplementation((async (...a: unknown[]) => {
      if (comes-- > 0 && rig.host.coolify) rig.host.coolify.running = true;
      return start(...a);
    }) as never);
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(rig.driver.events.filter((e) => e.code === "cutover.swap-source-restop")).toHaveLength(1);
    expect(rig.proxyOps.start).toHaveBeenCalledTimes(2);
    expect(rig.host.coolify!.running).toBe(false);
    expect(kinds(rig).filter((k) => k === "swap-stop-source")).toHaveLength(2);
    expect(rig.driver.rec("CUTOVER").compensation).toMatchObject({ swapGuardAttempts: 1 });
    // every host command is about the proxy containers: nothing addresses another container
    expect(kinds(rig).every((k) => ["swap-inspect", "swap-status", "swap-stop-source", "loopback-probe", "swap-reverse", "dark-probe"].includes(k))).toBe(true);
  });

  it("when Coolify wins the ports and Tugra's own start FAILS (port already allocated), the box is still taken back and the step passes", async () => {
    const rig = await swapRig();
    rig.host.startFailsOnPortConflict = true;
    let comes = 1;
    const start = rig.proxyOps.start.getMockImplementation() as unknown as (...a: unknown[]) => Promise<unknown>;
    rig.proxyOps.start.mockImplementation((async (...a: unknown[]) => {
      if (comes-- > 0 && rig.host.coolify) rig.host.coolify.running = true;
      return start(...a);
    }) as never);
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(r.fail).toBeUndefined();
    expect(rig.driver.events.filter((e) => e.code === "cutover.swap-source-restop")).toHaveLength(1);
    expect(rig.proxyOps.start).toHaveBeenCalledTimes(2);
    expect(rig.host.coolify!.running).toBe(false);
    expect(kinds(rig)).not.toContain("swap-reverse");
  });

  it("a start that fails while Coolify's proxy is NOT running is a plain failure with its own code (retryable, no take-back)", async () => {
    const rig = await swapRig();
    rig.proxyOps.start.mockImplementation((async () => {
      throw new Error("docker daemon unavailable");
    }) as never);
    const r = await drive(rig);
    expect(r.fail).toMatchObject({ code: "cutover.swap-start-failed", retryable: true });
    expect(rig.driver.events.filter((e) => e.code === "cutover.swap-source-restop")).toHaveLength(0);
  });

  it("a Coolify that keeps holding the ports while Tugra's start fails is bounded and ends with a code", async () => {
    const rig = await swapRig();
    rig.host.startFailsOnPortConflict = true;
    rig.host.coolifyComesBack = true;
    const r = await drive(rig);
    expect(r.fail).toMatchObject({ code: "cutover.swap-source-restarted", retryable: true });
    expect(rig.driver.events.filter((e) => e.code === "cutover.swap-source-restop")).toHaveLength(2);
    expect(kinds(rig)).not.toContain("swap-reverse");
  });

  it("a Coolify that keeps winning is bounded: the step fails with a code after the attempts and the swap stays reversible", async () => {
    const rig = await swapRig();
    rig.host.coolifyComesBack = true;
    const r = await drive(rig);
    expect(r.fail).toMatchObject({ code: "cutover.swap-ports-not-published", retryable: true });
    expect(rig.driver.events.filter((e) => e.code === "cutover.swap-source-restop")).toHaveLength(2);
    expect([...rig.world.swaps.values()][0].state).toBe("STARTING_TARGET_PROXY");
    expect(kinds(rig)).not.toContain("swap-reverse");
  });

  it("once LIVE, a Coolify proxy that is running again fails the post gate and is stopped again, a bounded number of times", async () => {
    const rig = await swapRig();
    expect((await drive(rig)).status).toBe("PASSED");
    rig.host.coolify!.running = true;
    const gate = await rig.driver.postGateOf(rig.handlers.cut);
    expect(gate.checks.find((c) => c.id === "cutover.swap-source-quiet")).toMatchObject({ status: "fail", code: "cutover.swap-source-restarted" });
    rig.driver.rec("CUTOVER").status = "PENDING";
    const t = await rig.driver.tick(rig.handlers.cut);
    expect(t.status).toBe("RUNNING");
    expect(rig.driver.events.filter((e) => e.code === "cutover.swap-source-restop")).toHaveLength(1);
    expect(rig.host.coolify!.running).toBe(false);
    // it keeps coming back: after the attempts the step fails with a code (retryable), never silently
    rig.host.coolifyAutoRestarts = true;
    let last = await rig.driver.tick(rig.handlers.cut);
    for (let i = 0; i < 4 && !last.fail; i++) {
      rig.host.coolify!.running = true;
      last = await rig.driver.tick(rig.handlers.cut);
    }
    expect(last.fail).toMatchObject({ code: "cutover.swap-source-restarted", retryable: true });
  });
});

describe("per-host attestations are usable through the rows the web renders", () => {
  const objApps = [{ id: "a1", host: H(1) }, { id: "a2", host: H(2) }, { id: "a3", host: H(3) }];

  it("object data (mirror): each waiting host has its own release and leave-out row, carrying the hostname; a click releases exactly that host", async () => {
    const rig = await ready({ apps: objApps, zone: zoneFor([H(1), H(2), H(3)]), policy: "mirror" });
    rig.world.objectKeys.set("a2", ["S3_ENDPOINT"]);
    rig.world.objectKeys.set("a3", ["S3_BUCKET"]);
    const r = await drive(rig);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(rows(rig)).toEqual([
      { id: OBJECT_CLEARED_ATTEST, subject: H(2) },
      { id: OBJECT_CLEARED_ATTEST, subject: H(3) },
      { id: LEFT_OUT_ATTEST, subject: H(2) },
      { id: LEFT_OUT_ATTEST, subject: H(3) },
    ]);
    expect(r.gate!.checks.find((c) => c.id === OBJECT_CLEARED_ATTEST && c.subject === H(2))).toMatchObject({ code: "cutover.release-object-cleared", params: { host: H(2) } });
    click(rig, OBJECT_CLEARED_ATTEST, H(2));
    click(rig, LEFT_OUT_ATTEST, H(3));
    const done = await drive(rig);
    expect(done.status).toBe("PASSED");
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [H(2)]: "VERIFIED", [H(3)]: "READY" });
  });

  it("a stopped service host can be left out from its own row", async () => {
    const rig = await ready({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: H(2), service: true }], zone: zoneFor([H(1), H(2)]) });
    expect((await drive(rig)).status).toBe("WAITING_OPERATOR");
    expect(rows(rig)).toEqual([{ id: LEFT_OUT_ATTEST, subject: H(2) }]);
    click(rig, LEFT_OUT_ATTEST, H(2));
    expect((await drive(rig)).status).toBe("PASSED");
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [H(2)]: "READY" });
  });

  it("the HTTP-01 gap is accepted from a row with the hostname", async () => {
    const rig = makeRig({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: H(2) }], zone: zoneFor([H(1), H(2)]), options: { ttlPolicy: "skip-ack" } });
    rig.proxyConfig.resolveFor.mockResolvedValue({ acmeEmail: "ops@realco.io", bind: "public" } as never);
    rig.sim.sslOk = false;
    rig.driver.attest("TLS_PREISSUE", HTTP01_GAP_ATTEST, H(1));
    rig.driver.attest("TLS_PREISSUE", HTTP01_GAP_ATTEST, H(2));
    expect((await rig.driver.drive(rig.handlers.dns)).status).toBe("PASSED");
    expect((await rig.driver.drive(rig.handlers.tls, { maxTicks: 120 })).status).toBe("PASSED");
    rig.driver.setStep("VERIFY", { status: "PASSED" });
    rig.driver.approve("VERIFY", HASH, { acceptDataRisk: true, expiresAt: new Date(rig.driver.now.getTime() + 3 * 3600_000).toISOString() });
    rig.phase.current = "cutover";
    rig.driver.rec("TLS_PREISSUE").evidence.attestations = [];
    rig.sim.sslOk = true;
    const r = await drive(rig);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(rows(rig)).toEqual(expect.arrayContaining([{ id: HTTP01_GAP_ATTEST, subject: H(1) }, { id: HTTP01_GAP_ATTEST, subject: H(2) }]));
    click(rig, HTTP01_GAP_ATTEST, H(1));
    click(rig, HTTP01_GAP_ATTEST, H(2));
    expect((await drive(rig)).status).toBe("PASSED");
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [H(2)]: "VERIFIED" });
  });

  describe("manual DNS", () => {
    const manual = ["m1.other.test", "m2.other.test", "m3.other.test"];
    const setup = () => ready({ apps: [{ id: "a1", host: H(1) }, ...manual.map((h, i) => ({ id: `a${i + 2}`, host: h }))], zone: zoneFor([H(1)]) });
    const resolves = (rig: Rig, hosts: string[]) => {
      const orig = rig.lookup.resolve4.getMockImplementation()!;
      rig.lookup.resolve4.mockImplementation((async (h: string) => (hosts.includes(h) ? [IP] : orig(h))) as never);
    };

    it("every host has its own confirm and defer row with the exact records and what the resolvers show, plus one row for all", async () => {
      const rig = await setup();
      const r = await drive(rig);
      expect(r.status).toBe("WAITING_OPERATOR");
      const gate = rig.driver.rec("CUTOVER").gate!;
      expect(rows(rig)).toEqual([
        { id: MANUAL_DNS_ATTEST },
        ...manual.map((h) => ({ id: MANUAL_DNS_ATTEST, subject: h })),
        ...manual.map((h) => ({ id: MANUAL_DNS_DEFER_ATTEST, subject: h })),
      ]);
      expect(gate.checks.find((c) => c.id === MANUAL_DNS_ATTEST && c.subject === manual[1])).toMatchObject({ code: "cutover.release-manual-dns", params: { host: manual[1], records: [`${manual[1]} A ${IP} ttl=60`], observed: expect.any(String) } });
      expect(gate.checks.find((c) => c.id === MANUAL_DNS_ATTEST && c.subject === undefined)).toMatchObject({ code: "cutover.release-manual-dns-all", params: { count: 3 } });
    });

    it("defer one host, confirm another, and confirm the rest with the all-hosts row", async () => {
      const rig = await setup();
      await drive(rig);
      click(rig, MANUAL_DNS_DEFER_ATTEST, manual[2]);
      resolves(rig, [manual[0], manual[1]]);
      click(rig, MANUAL_DNS_ATTEST, manual[0]);
      rig.driver.advance(60_000);
      const t = await rig.driver.tick(rig.handlers.cut, "tick");
      expect(t.wait).toMatchObject({ code: "cutover.manual-dns", params: { hosts: [manual[1]] } });
      expect(rows(rig)).toEqual([{ id: MANUAL_DNS_ATTEST }, { id: MANUAL_DNS_ATTEST, subject: manual[1] }, { id: MANUAL_DNS_DEFER_ATTEST, subject: manual[1] }]);
      click(rig, MANUAL_DNS_ATTEST);
      const done = await drive(rig);
      expect(done.status).toBe("PASSED");
      expect(states(rig)).toMatchObject({ [manual[0]]: "VERIFIED", [manual[1]]: "VERIFIED", [manual[2]]: "READY" });
    });

    it("a pending object host is released from the same parked checklist, by its own row", async () => {
      const rig = await ready({ apps: [{ id: "a1", host: H(1) }, { id: "a2", host: H(2) }, { id: "a3", host: manual[0] }], zone: zoneFor([H(1), H(2)]), policy: "mirror" });
      rig.world.objectKeys.set("a2", ["S3_ENDPOINT"]);
      await drive(rig);
      expect(rows(rig)).toEqual(expect.arrayContaining([{ id: OBJECT_CLEARED_ATTEST, subject: H(2) }, { id: LEFT_OUT_ATTEST, subject: H(2) }, { id: MANUAL_DNS_DEFER_ATTEST, subject: manual[0] }]));
      click(rig, OBJECT_CLEARED_ATTEST, H(2));
      await drive(rig);
      expect(states(rig)[H(2)]).toBe("VERIFIED");
    });
  });

  it("policy hold offers no release it cannot honour: the dependant stays on the source and the gate names the input that moves it", async () => {
    const rig = await ready({ apps: objApps.slice(0, 2), zone: zoneFor([H(1), H(2)]) });
    rig.world.objectKeys.set("a2", ["S3_ENDPOINT"]);
    await rig.driver.tick(rig.handlers.cut);
    expect(checkOf(rig, "cutover.object-hold")).toMatchObject({ ownerInput: "minioPolicy" });
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(rows(rig)).toEqual([]);
  });
});

describe("an app whose env cannot be read is not silently clear (fail closed)", () => {
  const apps = [{ id: "a1", host: H(1) }, { id: "a2", host: H(2) }];

  it("policy hold: the host stays on the source and a warning names it as unknown, with the input that decides it", async () => {
    const rig = await ready({ apps, zone: zoneFor([H(1), H(2)]) });
    rig.world.envUnreadable.add("a2");
    const flip = jest.spyOn(rig.cutover, "flip");
    await rig.driver.tick(rig.handlers.cut);
    expect(checkOf(rig, "cutover.object-env-unreadable")).toMatchObject({ status: "warn", ownerInput: "minioPolicy", params: { hosts: [H(2)], count: 1 } });
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(flips(rig, flip)).toEqual([{ hosts: [H(1)], autoRevert: true }]);
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [H(2)]: "READY" });
  });

  it("policy mirror: the host waits and can be released from its row once the operator knows it does not use object storage", async () => {
    const rig = await ready({ apps, zone: zoneFor([H(1), H(2)]), policy: "mirror" });
    rig.world.envUnreadable.add("a2");
    expect((await drive(rig)).status).toBe("WAITING_OPERATOR");
    expect(rows(rig)).toContainEqual({ id: OBJECT_CLEARED_ATTEST, subject: H(2) });
    click(rig, OBJECT_CLEARED_ATTEST, H(2));
    expect((await drive(rig)).status).toBe("PASSED");
    expect(states(rig)[H(2)]).toBe("VERIFIED");
  });

  it("policy external: nothing is held and nothing is said", async () => {
    const rig = await ready({ apps, zone: zoneFor([H(1), H(2)]), policy: "external" });
    rig.world.envUnreadable.add("a2");
    await rig.driver.tick(rig.handlers.cut);
    expect(checkOf(rig, "cutover.object-env-unreadable")).toBeUndefined();
    const r = await drive(rig);
    expect(r.status).toBe("PASSED");
    expect(states(rig)).toMatchObject({ [H(1)]: "VERIFIED", [H(2)]: "VERIFIED" });
  });

  it("the dry run says how many apps could not be read", async () => {
    const rig = makeRig({ apps, zone: zoneFor([H(1), H(2)]), run: { dryRun: true } });
    rig.world.envUnreadable.add("a1");
    const items = await rig.handlers.cut.dryRun(rig.driver.contextFor("CUTOVER"));
    expect(items.find((i) => i.code === "cutover.dry.object-env-unreadable")).toMatchObject({ level: "warn", params: { apps: 1 } });
  });
});

import { ConflictException, ForbiddenException } from "@nestjs/common";
import { CutoverService } from "./cutover.service";
import { DnsAutomationService } from "../dns/dns-automation.service";
import { fakeCloudflare, fakeCutoverPrisma, type ZoneRec } from "./cutover.fakes";
import { CutoverRevertSchema } from "./cutover.dto";

const OP = "op1";
const U = "user1";
const IP = "203.0.113.7";
const OLD = "198.51.100.1";
const H = (i: number) => `h${i}.example.com`;
const rec = (id: string, host: string, content = OLD, over: Partial<ZoneRec> = {}): ZoneRec => ({ id, type: "A", name: host, content, ttl: 3600, proxied: false, ...over });

interface Opts {
  zone?: ZoneRec[];
  tasks?: Array<{ itemRef: string; kind: string; status: string; dependsOn: string[]; resourceType: string | null; resourceId: string | null; result?: unknown }>;
  sslOk?: boolean;
  httpStatus?: number;
  permissionThrows?: boolean;
  generatedHost?: boolean;
}

function make(o: Opts = {}) {
  const prisma = fakeCutoverPrisma();
  const { zone, cf } = fakeCloudflare(o.zone ?? []);
  prisma.__servers.set("srv1", { id: "srv1", name: "target", proxyBind: "public", dnsCredentialId: "cred1", publicIp: IP, publicIpv6: null });
  const addApp = (id: string, over: Record<string, unknown> = {}) =>
    prisma.__apps.set(id, { id, name: `app-${id}`, teamId: "team1", serverId: "srv1", clusterId: null, domain: null, extraDomains: [], domainRedirect: null, dnsChallenge: false, ...over });
  const state = { sslOk: o.sslOk ?? true, httpStatus: o.httpStatus ?? 200, propagated: true, sleeps: [] as number[], applied: [] as string[] };
  const access = { requirePermission: jest.fn(async () => { if (o.permissionThrows) throw new ForbiddenException(); }) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const creds = {
    resolveToken: jest.fn(async () => ({ token: "TOK", cfAccountId: null, provider: "cloudflare", teamId: "team1" })),
    cloudflareCredentialsForTeam: jest.fn(async () => [{ id: "cred1", cfAccountId: null }]),
  };
  const lookup = {
    resolve4: jest.fn(async (h: string) => zone.records.filter((r) => r.name === h && r.type === "A").map((r) => r.content)),
    resolve6: jest.fn(async () => [] as string[]),
    resolveAuthoritative: jest.fn(async (h: string) => ({ addresses: state.propagated ? zone.records.filter((r) => r.name === h && r.type === "A").map((r) => r.content) : [OLD], ttl: 3600, ns: ["ns1"] })),
    resolvePublic: jest.fn(async (h: string) => {
      const a = state.propagated ? zone.records.filter((r) => r.name === h && r.type === "A").map((r) => r.content) : [OLD];
      return { "1.1.1.1": a, "8.8.8.8": a, "9.9.9.9": a };
    }),
  };
  const probe = {
    sslAt: jest.fn(async () => (state.sslOk ? { ok: true, issuer: "R3", subjectCN: "x", sans: [], validTo: new Date(Date.now() + 80 * 864e5).toISOString(), daysRemaining: 80 } : { ok: false, reason: "default-cert", issuer: null, subjectCN: "TRAEFIK DEFAULT CERT", sans: [], validTo: null, daysRemaining: null })),
    httpAt: jest.fn(async (_ip: string, _h: string, op: { tls: boolean }) => ({ status: op.tls ? state.httpStatus : 301, traefik404: false, location: op.tls ? null : "https://x/" })),
  };
  const proxyConfig = { resolveFor: jest.fn(async () => ({ acmeEmail: "ops@realco.io", bind: "public", dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "x" } })) };
  const agentWs = { sendCommand: jest.fn(async () => ({ exitCode: 0, output: "" })) };
  const apps = { setDomainOptions: jest.fn(async () => undefined) };
  const tasks = o.tasks ?? [];
  const executor = {
    ownedOpForCutover: jest.fn(async () => ({
      id: OP, meta: {}, cancelRequestedAt: null,
      tasks: tasks.map((t) => ({ result: { name: `src-${t.resourceId}` }, ...t })),
    })),
  };
  const dnsAuto = new DnsAutomationService(prisma as never, access as never, audit as never, cf as never, {} as never, creds as never, lookup as never);
  const svc = new CutoverService(prisma as never, access as never, audit as never, executor as never, dnsAuto, creds as never, lookup as never, probe as never, proxyConfig as never, agentWs as never, apps as never);
  svc.sleep = async (ms) => { state.sleeps.push(ms); };
  const appTask = (id: string, extra: Record<string, unknown> = {}) => ({ itemRef: `app:_:${id}`, kind: "app", status: "DONE", dependsOn: [], resourceType: "application", resourceId: id, ...extra });
  const seedEntry = (appId: string, host: string, over: Record<string, unknown> = {}) =>
    (prisma.cutoverDomain.create as (a: { data: Record<string, unknown> }) => Promise<{ id: string }>)({
      data: {
        opId: OP, applicationId: appId, hostname: host, state: "READY", dnsMode: "cloudflare", dnsCredentialId: "cred1", zoneId: "z1", sslMode: "strict", challenge: "dns01", certState: "ready",
        precheckAt: new Date(), precheck: { health: "ok" }, targetIps: { v4: [IP], v6: [] }, ...over,
      },
    });
  const row = (host: string) => prisma.cutoverDomain.rows.find((r) => r.hostname === host)!;
  return { svc, prisma, zone, cf, state, access, audit, creds, lookup, probe, proxyConfig, agentWs, apps, dnsAuto, addApp, appTask, seedEntry, row, tasks };
}

async function planAndFlip(m: ReturnType<typeof make>, input: Record<string, unknown> = {}) {
  const plan = await m.svc.flipPlan(U, OP, {});
  const res = await m.svc.flip(U, OP, { confirmToken: plan.planHash, ...input } as never);
  await m.svc.idle();
  return { plan, res };
}

describe("CutoverService.init", () => {
  it("derives entries idempotently, excludes generated hosts, blocks a tunnel host, never writes to the provider", async () => {
    const m = make({
      zone: [rec("r1", H(1)), rec("rt", "tun.example.com", "abc.cfargotunnel.com", { type: "CNAME", proxied: true })],
      tasks: [],
    });
    m.addApp("a1", { domain: H(1), extraDomains: ["app-ek8c4gk8s8kwk8go4kwc4skc.example.com", "tun.example.com"] });
    m.tasks.push(m.appTask("a1"));
    const v1 = await m.svc.init(U, OP, {});
    const by = Object.fromEntries(v1.entries.map((e) => [e.hostname, e]));
    expect(by[H(1)]).toMatchObject({ state: "PLANNED", dnsMode: "cloudflare", role: "primary", dnsObserved: "source" });
    expect(by["app-ek8c4gk8s8kwk8go4kwc4skc.example.com"]).toMatchObject({ state: "EXCLUDED", blockReason: "generated-host" });
    expect(by["tun.example.com"]).toMatchObject({ state: "BLOCKED", blockReason: "tunnel-routed", dnsObserved: "tunnel" });
    const writes = m.cf.createDnsRecord.mock.calls.length + m.cf.patchDnsRecord.mock.calls.length + m.cf.deleteDnsRecord.mock.calls.length;
    expect(writes).toBe(0);
    const v2 = await m.svc.init(U, OP, {});
    expect(v2.entries).toHaveLength(v1.entries.length);
    expect(m.prisma.cutoverDomain.rows).toHaveLength(v1.entries.length);
  });

  it("denies a team without apps:config and a foreign op", async () => {
    const m = make({ permissionThrows: true });
    m.addApp("a1", { domain: H(1) });
    m.tasks.push(m.appTask("a1"));
    await expect(m.svc.init(U, OP, {})).rejects.toBeInstanceOf(ForbiddenException);
    const f = make();
    (f.svc as unknown as { executor: { ownedOpForCutover: jest.Mock } }).executor.ownedOpForCutover = jest.fn().mockRejectedValue(new ForbiddenException("not your operation"));
    await expect(f.svc.init(U, OP, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("adds an evidenced www counterpart as BLOCKED(counterpart-not-served) until fix-counterpart", async () => {
    const m = make({ zone: [rec("r1", "example.com"), rec("r2", "www.example.com")] });
    m.addApp("a1", { domain: "example.com" });
    m.tasks.push(m.appTask("a1"));
    const v = await m.svc.init(U, OP, {});
    expect(v.entries.find((e) => e.hostname === "www.example.com")).toMatchObject({ role: "counterpart", state: "BLOCKED", blockReason: "counterpart-not-served" });
    const f = await m.svc.fixCounterpart(U, OP, { applicationId: "a1", direction: "root" });
    expect(m.apps.setDomainOptions).toHaveBeenCalledWith(U, "a1", { domainRedirect: "root" });
    expect(f.entries.find((e) => e.hostname === "www.example.com")).toMatchObject({ state: "PLANNED", needsDeploy: true });
  });

  it("marks stateful from the op's data tasks", async () => {
    const m = make({ zone: [rec("r1", H(1))] });
    m.addApp("a1", { domain: H(1) });
    m.tasks.push(m.appTask("a1", { dependsOn: ["database:_:9"] }));
    const v = await m.svc.init(U, OP, {});
    expect(v.entries[0].stateful).toBe(true);
  });

  it("is manual-DNS when no credential sees the zone, and a cluster app is blocked", async () => {
    const m = make();
    m.addApp("a1", { domain: "foo.other.net" });
    m.addApp("a2", { domain: "c.example.com", clusterId: "cl1" });
    m.tasks.push(m.appTask("a1"), m.appTask("a2"));
    const v = await m.svc.init(U, OP, {});
    expect(v.entries.find((e) => e.hostname === "foo.other.net")).toMatchObject({ dnsMode: "manual", state: "PLANNED" });
    expect(v.entries.find((e) => e.hostname === "c.example.com")).toMatchObject({ state: "BLOCKED", blockReason: "cluster-app" });
  });
});

describe("CutoverService.check", () => {
  it("promotes PLANNED to READY when the cert and health pass, and reports needsDeploy otherwise", async () => {
    const m = make({ zone: [rec("r1", H(1))] });
    m.addApp("a1", { domain: H(1) });
    m.tasks.push(m.appTask("a1"));
    await m.seedEntry("a1", H(1), { state: "PLANNED", certState: "unknown", precheckAt: null, precheck: null });
    await m.svc.check(U, OP, {});
    expect(m.row(H(1))).toMatchObject({ state: "READY", certState: "ready" });
    expect(m.probe.sslAt).toHaveBeenCalledWith(IP, H(1));
    expect(m.probe.httpAt).toHaveBeenCalledWith(IP, H(1), expect.objectContaining({ tls: true }));
  });

  it("a missing cert keeps an https-challenge host CERT_PENDING and a failed re-check demotes READY", async () => {
    const m = make({ zone: [rec("r1", H(1))], sslOk: false });
    m.addApp("a1", { domain: H(1) });
    m.tasks.push(m.appTask("a1"));
    await m.seedEntry("a1", H(1), { state: "READY" });
    await m.svc.check(U, OP, {});
    expect(m.row(H(1)).state).toBe("CERT_PENDING");
    expect(m.row(H(1)).certState).toBe("default-cert");
  });

  it("an http-01 host is READY without a cert (the flip then needs acceptHttp01Gap)", async () => {
    const m = make({ zone: [rec("r1", H(1))], sslOk: false });
    m.addApp("a1", { domain: H(1) });
    m.tasks.push(m.appTask("a1"));
    await m.seedEntry("a1", H(1), { state: "PLANNED", challenge: "http01", certState: "unknown", precheckAt: null });
    await m.svc.check(U, OP, {});
    expect(m.row(H(1)).state).toBe("READY");
  });

  it("a probe that cannot connect never promotes", async () => {
    const m = make({ zone: [rec("r1", H(1))], httpStatus: 502 });
    m.addApp("a1", { domain: H(1) });
    m.tasks.push(m.appTask("a1"));
    await m.seedEntry("a1", H(1), { state: "PLANNED", certState: "unknown", precheckAt: null });
    await m.svc.check(U, OP, {});
    expect(m.row(H(1)).state).toBe("CERT_READY");
  });

  it("a manual-DNS host auto-advances to VERIFIED once the public resolvers show the target", async () => {
    const m = make();
    m.addApp("a1", { domain: "foo.other.net" });
    m.tasks.push(m.appTask("a1"));
    await m.seedEntry("a1", "foo.other.net", { dnsMode: "manual", dnsCredentialId: null, zoneId: null });
    m.lookup.resolve4.mockResolvedValue([IP]);
    await m.svc.check(U, OP, {});
    expect(m.row("foo.other.net").state).toBe("VERIFIED");
    expect(m.cf.patchDnsRecord).not.toHaveBeenCalled();
    expect(m.cf.createDnsRecord).not.toHaveBeenCalled();
  });
});

describe("CutoverService.ttl", () => {
  it("lowers an unproxied record and sets the wait; proxied records are skipped", async () => {
    const m = make({ zone: [rec("r1", H(1)), rec("r2", H(2), OLD, { proxied: true, ttl: 1 })] });
    m.addApp("a1", { domain: H(1), extraDomains: [H(2)] });
    m.tasks.push(m.appTask("a1"));
    await m.seedEntry("a1", H(1));
    await m.seedEntry("a1", H(2));
    await m.svc.ttl(U, OP, { ttl: 60 });
    expect(m.zone.records.find((r) => r.id === "r1")!.ttl).toBe(60);
    expect(m.zone.records.find((r) => r.id === "r2")!.ttl).toBe(1);
    expect(m.row(H(1))).toMatchObject({ originalTtl: 3600, targetTtl: 60 });
    expect(m.row(H(1)).earliestFlipAt as Date).toBeInstanceOf(Date);
    expect((m.row(H(1)).earliestFlipAt as Date).getTime()).toBeGreaterThan(Date.now() + 3500_000);
    expect(m.row(H(2)).warnings).toContain("ttl-proxied");
  });

  it("manual hosts get guidance and nothing is written", async () => {
    const m = make();
    m.addApp("a1", { domain: "foo.other.net" });
    m.tasks.push(m.appTask("a1"));
    await m.seedEntry("a1", "foo.other.net", { dnsMode: "manual", dnsCredentialId: null, zoneId: null });
    const r = await m.svc.ttl(U, OP, {});
    expect(r.guidance[0]).toMatchObject({ hostname: "foo.other.net", oldTtl: 3600 });
    expect(m.cf.patchDnsRecord).not.toHaveBeenCalled();
  });
});

describe("CutoverService flip", () => {
  const base = (n = 1, over: Record<string, unknown> = {}) => {
    const m = make({ zone: Array.from({ length: n }, (_, i) => rec(`r${i}`, H(i))) });
    for (let i = 0; i < n; i++) {
      m.addApp(`a${i}`, { domain: H(i) });
      m.tasks.push(m.appTask(`a${i}`));
    }
    return Promise.all(Array.from({ length: n }, (_, i) => m.seedEntry(`a${i}`, H(i), over))).then(() => m);
  };

  it("flips, verifies and records the ledger with the old values", async () => {
    const m = await base(1);
    const { res } = await planAndFlip(m);
    expect(res.queued).toBe(1);
    expect(m.zone.records[0]).toMatchObject({ content: IP, ttl: 60, id: "r0" });
    expect(m.row(H(0)).state).toBe("VERIFIED");
    const ledger = m.row(H(0)).ledger as Array<{ old: { content: string }; new: { content: string }; written: boolean }>;
    expect(ledger[0]).toMatchObject({ old: { content: OLD }, new: { content: IP }, written: true });
    expect((m.prisma.cutoverRun.rows[0] as { status: string; activeKey: unknown })).toMatchObject({ status: "done", activeKey: null });
  });

  it("409 on a planHash that no longer matches (provider drift since review)", async () => {
    const m = await base(1);
    const plan = await m.svc.flipPlan(U, OP, {});
    m.zone.records[0].content = "198.51.100.99";
    await expect(m.svc.flip(U, OP, { confirmToken: plan.planHash } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(m.cf.patchDnsRecord).not.toHaveBeenCalled();
  });

  it("409 for a stateful host without acceptDataRisk, BEFORE any write", async () => {
    const m = await base(1, { stateful: true });
    const plan = await m.svc.flipPlan(U, OP, {});
    expect(plan.entries[0].warnings).toContain("stateful");
    await expect(m.svc.flip(U, OP, { confirmToken: plan.planHash } as never)).rejects.toThrow(/acceptDataRisk/);
    expect(m.cf.patchDnsRecord).not.toHaveBeenCalled();
    expect(m.prisma.cutoverRun.rows).toHaveLength(0);
    await m.svc.flip(U, OP, { confirmToken: plan.planHash, acceptDataRisk: true } as never);
    await m.svc.idle();
    expect(m.row(H(0)).state).toBe("VERIFIED");
  });

  it("an http-01 host without a cert needs acceptHttp01Gap; the TTL wait is enforced unless skipped", async () => {
    const m = await base(1, { challenge: "http01", certState: "pending" });
    const plan = await m.svc.flipPlan(U, OP, {});
    await expect(m.svc.flip(U, OP, { confirmToken: plan.planHash } as never)).rejects.toThrow(/acceptHttp01Gap/);
    const m2 = await base(1, { earliestFlipAt: new Date(Date.now() + 3600_000) });
    const p2 = await m2.svc.flipPlan(U, OP, {});
    expect(p2.entries[0].warnings).toContain("ttl-not-waited");
    await expect(m2.svc.flip(U, OP, { confirmToken: p2.planHash } as never)).rejects.toThrow(/TTL wait/);
    await expect(m2.svc.flip(U, OP, { confirmToken: p2.planHash.replace(/./, "0") } as never)).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses when nothing is READY (BLOCKED and non-READY entries are never flipped)", async () => {
    const m = await base(1, { state: "BLOCKED", blockReason: "tunnel-routed" });
    await expect(m.svc.flip(U, OP, { confirmToken: "a".repeat(64) } as never)).rejects.toThrow(/READY/);
    const plan = await m.svc.flipPlan(U, OP, {});
    expect(plan.blocked).toEqual([{ hostname: H(0), reason: "tunnel-routed" }]);
  });

  it("paces 12 hosts as batches of 5/5/2 with the interval between them", async () => {
    const m = await base(12);
    const order: string[] = [];
    m.cf.patchDnsRecord.mockImplementation(async (_t, _z, id, p) => {
      order.push(id);
      const r = m.zone.records.find((x) => x.id === id)!;
      Object.assign(r, p);
      return { ...r };
    });
    await planAndFlip(m, { batchSize: 5, intervalSec: 30 });
    expect(m.state.sleeps.filter((s) => s === 30_000)).toHaveLength(2);
    expect(m.prisma.cutoverRun.rows[0]).toMatchObject({ batchesDone: 3, status: "done" });
    expect(order).toHaveLength(12);
    expect([...order].sort()).toEqual(m.zone.records.map((r) => r.id).sort());
    expect(m.prisma.cutoverDomain.rows.every((r) => r.state === "VERIFIED")).toBe(true);
  });

  it("an entry whose provider records drifted after the plan becomes CONFLICT and nothing is written for it", async () => {
    const m = await base(1);
    const plan = await m.svc.flipPlan(U, OP, {});
    // drift AFTER the confirm check but BEFORE the write: the entry gate re-reads the provider
    const realList = m.cf.listDnsRecords.getMockImplementation()!;
    let reads = 0;
    m.cf.listDnsRecords.mockImplementation(async (t, z, f) => {
      reads++;
      if (reads > 1) m.zone.records[0].content = "198.51.100.77";
      return realList(t, z, f);
    });
    await m.svc.flip(U, OP, { confirmToken: plan.planHash } as never);
    await m.svc.idle();
    expect(m.row(H(0))).toMatchObject({ state: "CONFLICT", blockReason: "record-changed" });
    expect(m.zone.calls.some((c) => c.startsWith("patch") || c.startsWith("create") || c.startsWith("delete"))).toBe(false);
  });

  it("persists the ledger before the first provider write (a crash mid-way leaves written flags accurate)", async () => {
    const m = await base(1);
    m.zone.records.push({ id: "r9", type: "AAAA", name: H(0), content: "2001:db8::1", ttl: 3600, proxied: false });
    let ledgerAtFirstWrite: unknown = "never";
    m.cf.patchDnsRecord.mockImplementationOnce(async () => {
      ledgerAtFirstWrite = m.row(H(0)).ledger;
      throw new Error("cf 500");
    });
    await planAndFlip(m);
    expect(ledgerAtFirstWrite).not.toBeNull();
    expect((ledgerAtFirstWrite as Array<{ written: boolean }>).every((s) => s.written === false)).toBe(true);
    expect(m.row(H(0)).state).toBe("CONFLICT");
    expect(m.row(H(0)).blockReason).toBe("provider-write-failed");
  });

  it("two simultaneous flips: exactly one wins the run claim", async () => {
    const m = await base(1);
    const plan = await m.svc.flipPlan(U, OP, {});
    const [a, b] = await Promise.allSettled([m.svc.flip(U, OP, { confirmToken: plan.planHash } as never), m.svc.flip(U, OP, { confirmToken: plan.planHash } as never)]);
    await m.svc.idle();
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = [a, b].find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(m.prisma.cutoverRun.rows).toHaveLength(1);
  });

  it("a failed verification halts the run (stopOnFail) and leaves later batches untouched", async () => {
    const m = await base(3);
    m.state.propagated = false; // resolvers keep answering the old IP
    await planAndFlip(m, { batchSize: 1, intervalSec: 5, stopOnFail: true });
    const states = ["h0", "h1", "h2"].map((h) => m.row(`${h}.example.com`).state);
    expect(states).toEqual(["VERIFY_FAILED", "READY", "READY"]);
    expect(m.prisma.cutoverRun.rows[0]).toMatchObject({ status: "halted", activeKey: null });
    expect(m.state.sleeps.filter((s) => s === 10_000)).toHaveLength(5); // 6 attempts, 5 backoffs
    expect(m.zone.records.find((r) => r.name === "h1.example.com")!.content).toBe(OLD);
  });

  it("autoRevert reverts only the non-stateful failed entry and never a stateful one", async () => {
    const m = await base(2);
    await m.prisma.cutoverDomain.update({ where: { id: m.row(H(1)).id as string }, data: { stateful: true } });
    m.state.propagated = false;
    await planAndFlip(m, { batchSize: 5, autoRevert: true, acceptDataRisk: true, stopOnFail: false });
    expect(m.row(H(0)).state).toBe("ROLLED_BACK");
    expect(m.zone.records.find((r) => r.name === H(0))!.content).toBe(OLD);
    expect(m.row(H(1)).state).toBe("VERIFY_FAILED");
    expect(m.zone.records.find((r) => r.name === H(1))!.content).toBe(IP);
  });

  it("cancel stops the run between batches", async () => {
    const m = await base(3);
    const plan = await m.svc.flipPlan(U, OP, {});
    m.svc.sleep = async () => {
      m.prisma.__cancel = true;
    };
    await m.svc.flip(U, OP, { confirmToken: plan.planHash, batchSize: 1, intervalSec: 5 } as never);
    await m.svc.idle();
    expect(m.row(H(0)).state).toBe("VERIFIED");
    expect(m.row(H(1)).state).toBe("READY");
    expect(m.prisma.cutoverRun.rows[0]).toMatchObject({ status: "cancelled", activeKey: null });
  });

  it("refuses a proxied host in a flexible-SSL zone (fails closed), and keeps proxied on a strict zone", async () => {
    const m = make({ zone: [rec("r0", H(0), OLD, { proxied: true, ttl: 1 })] });
    m.addApp("a0", { domain: H(0) });
    m.tasks.push(m.appTask("a0"));
    await m.seedEntry("a0", H(0), { proxied: true });
    m.zone.sslMode = "flexible";
    await planAndFlip(m);
    expect(m.row(H(0))).toMatchObject({ state: "READY", lastError: "ssl-mode-bad" });
    expect(m.zone.records[0].content).toBe(OLD);
    m.zone.sslMode = "strict";
    await planAndFlip(m);
    expect(m.row(H(0)).state).toBe("VERIFIED");
    expect(m.zone.records[0]).toMatchObject({ content: IP, proxied: true, ttl: 1 });
  });

  it("gates on the target server: a placeholder ACME email blocks the flip for that host", async () => {
    const m = await base(1);
    m.proxyConfig.resolveFor.mockResolvedValue({ acmeEmail: "admin@example.com", bind: "public", dnsProvider: "cloudflare", dnsCreds: { A: "b" } } as never);
    await planAndFlip(m);
    expect(m.row(H(0))).toMatchObject({ state: "READY", lastError: "acme-email" });
    expect(m.zone.records[0].content).toBe(OLD);
  });

  it("a stale precheck is re-run inline, and a failing re-check does not flip", async () => {
    const m = await base(1, { precheckAt: new Date(Date.now() - 3600_000) });
    m.state.httpStatus = 502;
    await planAndFlip(m);
    expect(m.row(H(0)).state).toBe("READY");
    expect(m.zone.records[0].content).toBe(OLD);
  });

  it("a manual-DNS host is never written by the run; the plan prints copy-paste records", async () => {
    const m = make();
    m.addApp("a0", { domain: "foo.other.net" });
    m.tasks.push(m.appTask("a0"));
    await m.seedEntry("a0", "foo.other.net", { dnsMode: "manual", dnsCredentialId: null, zoneId: null });
    const plan = await m.svc.flipPlan(U, OP, {});
    expect(plan.copyPaste).toEqual([expect.objectContaining({ hostname: "foo.other.net", type: "A", content: IP, ttl: 60 })]);
    expect(plan.sourceStop).toEqual([{ appName: "app-a0", sourceName: "src-a0", hostnames: ["foo.other.net"] }]);
    await expect(m.svc.flip(U, OP, { confirmToken: plan.planHash } as never)).rejects.toThrow(/nothing to flip/);
    expect(m.cf.patchDnsRecord).not.toHaveBeenCalled();
  });

  it("never flips a record Tugra did not plan: sibling TXT/MX records and other hosts stay untouched", async () => {
    const m = await base(1);
    m.zone.records.push({ id: "t1", type: "TXT", name: H(0), content: "v=spf1", ttl: 300, proxied: false }, rec("other", "other.example.com"));
    await planAndFlip(m);
    expect(m.zone.records.find((r) => r.id === "t1")).toMatchObject({ content: "v=spf1", ttl: 300 });
    expect(m.zone.records.find((r) => r.id === "other")).toMatchObject({ content: OLD, ttl: 3600 });
  });
});

describe("settle", () => {
  it("a stale SWITCHING row settles to SWITCHED when the provider holds the new content, to READY when it holds the old", async () => {
    const m = make({ zone: [rec("r0", H(0), IP, { ttl: 60 }), rec("r1", H(1), OLD)] });
    for (const i of [0, 1]) {
      m.addApp(`a${i}`, { domain: H(i) });
      m.tasks.push(m.appTask(`a${i}`));
      await m.seedEntry(`a${i}`, H(i), {
        state: "SWITCHING",
        ledger: [{ type: "A", name: H(i), recordId: `r${i}`, old: { content: OLD, ttl: 3600, proxied: false }, new: { content: IP, ttl: 60, proxied: false }, written: i === 0 }],
      });
    }
    for (const r of m.prisma.cutoverDomain.rows) r.updatedAt = new Date(Date.now() - 10 * 60_000);
    await m.svc.view(U, OP);
    expect(m.row(H(0)).state).toBe("SWITCHED");
    expect(m.row(H(1)).state).toBe("READY");
  });

  it("a record changed to something else during an interrupted flip is CONFLICT", async () => {
    const m = make({ zone: [rec("r0", H(0), "192.0.2.50")] });
    m.addApp("a0", { domain: H(0) });
    m.tasks.push(m.appTask("a0"));
    await m.seedEntry("a0", H(0), { state: "SWITCHING", ledger: [{ type: "A", name: H(0), recordId: "r0", old: { content: OLD, ttl: 3600, proxied: false }, new: { content: IP, ttl: 60, proxied: false }, written: true }] });
    m.row(H(0)).updatedAt = new Date(Date.now() - 10 * 60_000);
    await m.svc.view(U, OP);
    expect(m.row(H(0)).state).toBe("CONFLICT");
  });

  it("a run whose heartbeat stopped is halted and frees the claim", async () => {
    const m = make();
    await m.prisma.cutoverRun.create({ data: { opId: OP, activeKey: OP, params: {}, total: 1, heartbeatAt: new Date(Date.now() - 5 * 60_000) } });
    const v = await m.svc.view(U, OP);
    expect(v.run).toMatchObject({ status: "halted" });
    expect(m.prisma.cutoverRun.rows[0].activeKey).toBeNull();
  });
});

describe("revert / finalize", () => {
  const flipped = async (extra: Array<ZoneRec> = []) => {
    const m = make({ zone: [rec("r0", H(0)), { id: "q0", type: "AAAA", name: H(0), content: "2001:db8::1", ttl: 3600, proxied: false }, ...extra] });
    m.addApp("a0", { domain: H(0) });
    m.tasks.push(m.appTask("a0"));
    await m.seedEntry("a0", H(0), { originalTtl: 3600 });
    await planAndFlip(m);
    return m;
  };

  it("restores the byte-identical record set, including the stale AAAA that the flip deleted", async () => {
    const m = await flipped();
    expect(m.zone.records.some((r) => r.type === "AAAA")).toBe(false);
    await m.svc.revert(U, OP, { hostnames: [H(0)], acknowledgeDataLoss: true });
    expect(m.row(H(0)).state).toBe("ROLLED_BACK");
    const set = m.zone.records.map((r) => [r.type, r.name, r.content, r.ttl, r.proxied]).sort();
    expect(set).toEqual([["A", H(0), OLD, 3600, false], ["AAAA", H(0), "2001:db8::1", 3600, false]].sort());
  });

  it("a record changed since the flip is a CONFLICT and nothing is overwritten; force restores anyway", async () => {
    const m = await flipped();
    m.zone.records.find((r) => r.id === "r0")!.content = "192.0.2.99";
    await m.svc.revert(U, OP, { hostnames: [H(0)], acknowledgeDataLoss: true });
    expect(m.row(H(0))).toMatchObject({ state: "CONFLICT", blockReason: "record-changed-since-flip" });
    expect(m.zone.records.find((r) => r.id === "r0")!.content).toBe("192.0.2.99");
    expect(m.zone.records.some((r) => r.type === "AAAA")).toBe(false);
    // the CONFLICT row keeps its ledger, so the owner can retry with force
    await m.svc.revert(U, OP, { hostnames: [H(0)], acknowledgeDataLoss: true, force: true });
    expect(m.row(H(0)).state).toBe("ROLLED_BACK");
    expect(m.zone.records.find((r) => r.id === "r0")!.content).toBe(OLD);
  });

  it("force restores over a changed record", async () => {
    const m = await flipped();
    m.zone.records.find((r) => r.id === "r0")!.content = "192.0.2.99";
    await m.svc.revert(U, OP, { hostnames: [H(0)], acknowledgeDataLoss: true, force: true });
    expect(m.row(H(0)).state).toBe("ROLLED_BACK");
    expect(m.zone.records.find((r) => r.id === "r0")!.content).toBe(OLD);
  });

  it("requires the data-loss acknowledgement literal", () => {
    expect(CutoverRevertSchema.safeParse({ hostnames: ["a.example.com"] }).success).toBe(false);
    expect(CutoverRevertSchema.safeParse({ hostnames: ["a.example.com"], acknowledgeDataLoss: false }).success).toBe(false);
    expect(CutoverRevertSchema.safeParse({ hostnames: ["a.example.com"], acknowledgeDataLoss: true }).success).toBe(true);
  });

  it("refuses to revert a host that was never switched", async () => {
    const m = make({ zone: [rec("r0", H(0))] });
    m.addApp("a0", { domain: H(0) });
    m.tasks.push(m.appTask("a0"));
    await m.seedEntry("a0", H(0));
    await expect(m.svc.revert(U, OP, { hostnames: [H(0)], acknowledgeDataLoss: true })).rejects.toBeInstanceOf(ConflictException);
  });

  it("a re-plannable rollback: init moves ROLLED_BACK back to PLANNED", async () => {
    const m = await flipped();
    await m.svc.revert(U, OP, { hostnames: [H(0)], acknowledgeDataLoss: true });
    await m.svc.init(U, OP, {});
    expect(m.row(H(0)).state).toBe("PLANNED");
  });

  it("finalize puts the original TTL back; auto stays auto for a created record", async () => {
    const m = await flipped();
    expect(m.zone.records.find((r) => r.id === "r0")!.ttl).toBe(60);
    await m.svc.finalize(U, OP, {});
    expect(m.zone.records.find((r) => r.id === "r0")!.ttl).toBe(3600);
    expect(m.row(H(0)).finalizedAt).toBeInstanceOf(Date);
    const wild = make({ zone: [] });
    wild.addApp("a0", { domain: H(0) });
    wild.tasks.push(wild.appTask("a0"));
    await wild.seedEntry("a0", H(0), { viaWildcard: true });
    await planAndFlip(wild);
    expect(wild.zone.records[0].ttl).toBe(60);
    await wild.svc.finalize(U, OP, {});
    expect(wild.zone.records[0].ttl).toBe(1);
    await wild.svc.revert(U, OP, { hostnames: [H(0)], acknowledgeDataLoss: true });
    expect(wild.zone.records).toHaveLength(0); // the explicit record Tugra created is deleted again
  });

  it("exclude / include toggles hosts", async () => {
    const m = make();
    m.addApp("a0", { domain: H(0) });
    m.tasks.push(m.appTask("a0"));
    await m.seedEntry("a0", H(0), { state: "PLANNED" });
    await m.svc.exclude(U, OP, { hostnames: [H(0)], excluded: true });
    expect(m.row(H(0)).state).toBe("EXCLUDED");
    await m.svc.exclude(U, OP, { hostnames: [H(0)], excluded: false });
    expect(m.row(H(0)).state).toBe("PLANNED");
  });
});

describe("cert-prepare", () => {
  it("turns on per-host DNS-01 through setDomainOptions and flags the deploy", async () => {
    const m = make({ zone: [rec("r0", H(0))] });
    m.addApp("a0", { domain: H(0) });
    m.tasks.push(m.appTask("a0"));
    await m.seedEntry("a0", H(0), { state: "PLANNED", challenge: "http01" });
    const r = await m.svc.certPrepare(U, OP, { challenge: "dns01" });
    expect(m.apps.setDomainOptions).toHaveBeenCalledWith(U, "a0", { dnsChallenge: true });
    expect(m.row(H(0))).toMatchObject({ challenge: "dns01", needsDeploy: true });
    expect(r.blocked).toEqual([]);
  });

  it("blocks a host the server credential cannot see and a server without DNS-01 credentials", async () => {
    const m = make({ zone: [rec("r0", "x.other.net")] });
    m.addApp("a0", { domain: "x.other.net" });
    m.tasks.push(m.appTask("a0"));
    await m.seedEntry("a0", "x.other.net", { state: "PLANNED" });
    const r = await m.svc.certPrepare(U, OP, { challenge: "dns01" });
    expect(r.blocked).toEqual([{ hostname: "x.other.net", reason: "zone-not-covered" }]);
    expect(m.apps.setDomainOptions).not.toHaveBeenCalled();
    const n = make();
    n.addApp("a0", { domain: H(0) });
    n.tasks.push(n.appTask("a0"));
    await n.seedEntry("a0", H(0), { state: "PLANNED" });
    n.proxyConfig.resolveFor.mockResolvedValue({ acmeEmail: "ops@realco.io", bind: "public" } as never);
    expect((await n.svc.certPrepare(U, OP, { challenge: "dns01" })).blocked[0].reason).toBe("no-dns-credential");
  });

  it("http01 turns the flag off", async () => {
    const m = make();
    m.addApp("a0", { domain: H(0) });
    m.tasks.push(m.appTask("a0"));
    await m.seedEntry("a0", H(0), { state: "PLANNED", challenge: "dns01" });
    await m.svc.certPrepare(U, OP, { challenge: "http01" });
    expect(m.apps.setDomainOptions).toHaveBeenCalledWith(U, "a0", { dnsChallenge: false });
  });
});

describe("migration-run additions", () => {
  it("certPrepare(http01, unblockDnsBlocked) lifts a DNS-01-only block; without the option the block stays", async () => {
    const m = make({ zone: [rec("r0", "x.other.net")] });
    m.addApp("a0", { domain: "x.other.net" });
    m.tasks.push(m.appTask("a0"));
    await m.seedEntry("a0", "x.other.net", { state: "PLANNED" });
    await m.svc.certPrepare(U, OP, { challenge: "dns01" });
    expect(m.row("x.other.net")).toMatchObject({ state: "BLOCKED", blockReason: "zone-not-covered" });
    await m.svc.certPrepare(U, OP, { challenge: "http01" });
    expect(m.row("x.other.net").state).toBe("BLOCKED");
    await m.svc.certPrepare(U, OP, { challenge: "http01" }, { unblockDnsBlocked: true });
    expect(m.row("x.other.net")).toMatchObject({ state: "PLANNED", blockReason: null, challenge: "http01", needsDeploy: true });
  });

  it("certPrepare(unblockDnsBlocked) never lifts a block that is not about DNS-01 (a tunnel host stays blocked)", async () => {
    const m = make();
    m.addApp("a0", { domain: H(0) });
    m.tasks.push(m.appTask("a0"));
    await m.seedEntry("a0", H(0), { state: "BLOCKED", blockReason: "tunnel-routed" });
    await m.svc.certPrepare(U, OP, { challenge: "http01" }, { unblockDnsBlocked: true });
    expect(m.row(H(0)).state).toBe("BLOCKED");
  });

  it("restoreTtlsUnflipped puts the original TTL back on an unflipped host only, and leaves a TTL the owner changed alone", async () => {
    const m = make({ zone: [rec("r1", H(1)), rec("r2", H(2)), rec("r3", H(3))] });
    for (const i of [1, 2, 3]) {
      m.addApp(`a${i}`, { domain: H(i) });
      m.tasks.push(m.appTask(`a${i}`));
    }
    await m.seedEntry("a1", H(1));
    await m.seedEntry("a2", H(2));
    await m.seedEntry("a3", H(3));
    await m.svc.ttl(U, OP, { ttl: 60 });
    // the owner changed h2's TTL since; h3 was flipped (a ledger exists): revert owns it
    m.zone.records.find((r) => r.id === "r2")!.ttl = 300;
    m.row(H(3)).ledger = [{ type: "A" }];
    m.row(H(3)).state = "SWITCHED";
    const n = await m.svc.restoreTtlsUnflipped(U, OP);
    expect(n).toBe(1);
    expect(m.zone.records.find((r) => r.id === "r1")!.ttl).toBe(3600);
    expect(m.zone.records.find((r) => r.id === "r2")!.ttl).toBe(300);
    expect(m.zone.records.find((r) => r.id === "r3")!.ttl).toBe(60);
    expect(m.row(H(1)).ttlLoweredAt).toBeNull();
    // idempotent
    expect(await m.svc.restoreTtlsUnflipped(U, OP)).toBe(0);
  });
});

import { ServersService } from "../servers/servers.service";
import { TrafficController } from "./traffic.controller";
import { TrafficService } from "./traffic.service";

/**
 * Cross-team isolation, proven through the REAL composition: TrafficController -> real
 * ServersService.listForUser (membership filter) -> real TrafficService. Only the persistence edges are
 * faked (in-memory server / TrafficMetric / TrafficPath tables that honour the where-clauses the code
 * actually sends), so a regression in ANY layer (controller id-set, listForUser team filter, service
 * serverId scoping) leaks the victim's rows and fails here.
 */
const NOW = Date.UTC(2026, 10, 9, 12, 30, 0);
const bucket = new Date(NOW - 60_000);

const servers = [
  { id: "srv-alice", teamId: "team-alice", createdAt: new Date(2) },
  { id: "srv-bob", teamId: "team-bob", createdAt: new Date(1) },
];
const metricRows = [
  { serverId: "srv-alice", domain: "alice.com", appId: "app-a", bucket, requests: 11 },
  { serverId: "srv-bob", domain: "bob-secret.com", appId: "app-b", bucket, requests: 999 },
  // The SAME host served by both teams: the filter must only ever count the caller's side.
  { serverId: "srv-bob", domain: "alice.com", appId: null, bucket, requests: 5000 },
];
const pathRows = [
  { serverId: "srv-alice", domain: "alice.com", bucket, path: "/a", requests: 3, bytes: 30n },
  { serverId: "srv-bob", domain: "bob-secret.com", bucket, path: "/bob-secret", requests: 500, bytes: 5n },
  { serverId: "srv-bob", domain: "alice.com", bucket, path: "/a", requests: 7000, bytes: 70n },
];
const countryRows = [
  { serverId: "srv-alice", domain: "alice.com", bucket, country: "TR", requests: 3 },
  { serverId: "srv-bob", domain: "bob-secret.com", bucket, country: "KP", requests: 500 },
  { serverId: "srv-bob", domain: "alice.com", bucket, country: "TR", requests: 7000 },
];
const inScope = (r: any, w: any) =>
  w.serverId.in.includes(r.serverId) && r.bucket >= w.bucket.gte && (!w.domain || r.domain === w.domain);

function build() {
  const prisma: any = {
    server: {
      // honours both `teamId: x` and `teamId: { in: [...] }` exactly like Prisma would
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          servers.filter((s) => (typeof where.teamId === "string" ? s.teamId === where.teamId : where.teamId.in.includes(s.teamId))),
        ),
      ),
    },
    trafficMetric: {
      groupBy: jest.fn(({ where }: any) => {
        const acc = new Map<string, any>();
        for (const r of metricRows.filter((x) => inScope(x, where))) {
          const k = `${r.domain}|${r.appId}`;
          const a = acc.get(k) ?? { domain: r.domain, appId: r.appId, _sum: { requests: 0 } };
          a._sum.requests += r.requests;
          acc.set(k, a);
        }
        return Promise.resolve([...acc.values()]);
      }),
    },
    trafficPath: {
      groupBy: jest.fn(({ where }: any) => {
        const acc = new Map<string, any>();
        for (const r of pathRows.filter((x) => inScope(x, where) && x.path !== where.path?.not)) {
          const a = acc.get(r.path) ?? { path: r.path, _sum: { requests: 0, bytes: 0n } };
          a._sum.requests += r.requests;
          a._sum.bytes += r.bytes;
          acc.set(r.path, a);
        }
        return Promise.resolve([...acc.values()]);
      }),
      aggregate: jest.fn(() => Promise.resolve({ _sum: { requests: null, bytes: null } })),
    },
    trafficCountry: {
      groupBy: jest.fn(({ where }: any) => {
        const acc = new Map<string, any>();
        for (const r of countryRows.filter((x) => inScope(x, where))) {
          const a = acc.get(r.country) ?? { country: r.country, _sum: { requests: 0 } };
          a._sum.requests += r.requests;
          acc.set(r.country, a);
        }
        return Promise.resolve([...acc.values()]);
      }),
    },
    application: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          [
            { id: "app-a", name: "AliceShop", serverId: "srv-alice" },
            { id: "app-b", name: "BobSecretApp", serverId: "srv-bob" },
          ].filter((a) => where.id.in.includes(a.id) && where.serverId.in.includes(a.serverId)),
        ),
      ),
    },
    // Emulates the SQL: sums only rows whose serverId is among the bound ids (and domain if bound).
    $queryRaw: jest.fn((sql: any) => {
      const vals: unknown[] = sql.values;
      const wanted = metricRows.find((r) => vals.includes(r.domain))?.domain; // bound domain filter, if any
      const scoped = metricRows.filter((r) => vals.includes(r.serverId) && (!wanted || r.domain === wanted));
      const total = scoped.reduce((n, r) => n + r.requests, 0);
      const stepMs = 900_000; // default 24h range => 15-minute buckets (the SQL floors to the step)
      const t = BigInt(Math.floor(bucket.getTime() / stepMs) * stepMs);
      return Promise.resolve(scoped.length ? [{ t, requests: BigInt(total), s2xx: BigInt(total), s3xx: 0n, s4xx: 0n, s5xx: 0n, bytes: 0n }] : []);
    }),
  };
  // Membership: alice belongs to team-alice only; bob to team-bob only; mallory to nothing.
  const access = {
    permissionsByTeam: jest.fn((userId: string) => {
      const m = new Map<string, Set<string>>();
      if (userId === "alice") m.set("team-alice", new Set(["servers:manage"]));
      if (userId === "bob") m.set("team-bob", new Set());
      return Promise.resolve(m);
    }),
  };
  const serversSvc = new ServersService(prisma, {} as any, {} as any, {} as any, {} as any, access as any);
  const ctrl = new TrafficController(serversSvc, new TrafficService(prisma));
  return { ctrl, prisma };
}
const as = (userId: string) => ({ userId }) as any;

describe("traffic reads: a user can never read another team's traffic", () => {
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it("domains: alice sees only her host; victim's host/app name never appear", async () => {
    const { ctrl } = build();
    const out = await ctrl.domains(as("alice"), { range: "24h" });
    expect(out).toEqual([{ domain: "alice.com", appId: "app-a", appName: "AliceShop", requests: 11 }]); // not 11 + 5000
    const wire = JSON.stringify(out);
    expect(wire).not.toContain("bob-secret");
    expect(wire).not.toContain("BobSecretApp");
  });

  it("?teamId=<victim team> does not widen the set: empty result, no error, no data", async () => {
    const { ctrl } = build();
    expect(await ctrl.domains(as("alice"), { teamId: "team-bob" })).toEqual([]);
    const s = await ctrl.summary(as("alice"), { teamId: "team-bob" });
    expect(s.totals.requests).toBe(0);
    const p = await ctrl.paths(as("alice"), { teamId: "team-bob" });
    expect(p.paths).toEqual([]);
    expect((await ctrl.countries(as("alice"), { teamId: "team-bob" })).countries).toEqual([]);
  });

  it("?domain=<victim-only host> reads nothing; ?domain=<shared host> counts only the caller's server", async () => {
    const { ctrl } = build();
    const victim = await ctrl.paths(as("alice"), { domain: "bob-secret.com" });
    expect(victim.paths).toEqual([]);
    expect((await ctrl.summary(as("alice"), { domain: "bob-secret.com" })).totals.requests).toBe(0);
    const shared = await ctrl.paths(as("alice"), { domain: "alice.com" });
    expect(shared.paths).toEqual([{ path: "/a", requests: 3, bytes: 30 }]); // not 3 + 7000
    expect((await ctrl.summary(as("alice"), { domain: "alice.com" })).totals.requests).toBe(11); // not 5011
    expect((await ctrl.countries(as("alice"), { domain: "bob-secret.com" })).countries).toEqual([]);
    expect((await ctrl.countries(as("alice"), { domain: "alice.com" })).countries).toEqual([{ country: "TR", requests: 3 }]); // not 3 + 7000
  });

  it("a user in no team reads nothing from any endpoint, and the traffic tables are never queried", async () => {
    const { ctrl, prisma } = build();
    expect(await ctrl.domains(as("mallory"), {})).toEqual([]);
    expect((await ctrl.summary(as("mallory"), { domain: "alice.com" })).totals.requests).toBe(0);
    expect((await ctrl.paths(as("mallory"), { domain: "alice.com" })).paths).toEqual([]);
    expect(prisma.trafficMetric.groupBy).not.toHaveBeenCalled();
    expect(prisma.trafficPath.groupBy).not.toHaveBeenCalled();
    expect((await ctrl.countries(as("mallory"), {})).countries).toEqual([]);
    expect(prisma.trafficCountry.groupBy).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("countries: alice never sees bob's countries (unfiltered), bob sees only his", async () => {
    const { ctrl } = build();
    const alice = await ctrl.countries(as("alice"), {});
    expect(alice.countries).toEqual([{ country: "TR", requests: 3 }]);
    expect(JSON.stringify(alice)).not.toContain("KP");
    const bob = await ctrl.countries(as("bob"), {});
    expect(bob.countries.map((c) => c.country).sort()).toEqual(["KP", "TR"]);
  });

  it("bob sees only bob's side (symmetry)", async () => {
    const { ctrl } = build();
    const out = await ctrl.domains(as("bob"), {});
    expect(out.map((d) => d.domain).sort()).toEqual(["alice.com", "bob-secret.com"]);
    expect(out.find((d) => d.domain === "alice.com")!.requests).toBe(5000); // bob's own copy of that host only
  });
});

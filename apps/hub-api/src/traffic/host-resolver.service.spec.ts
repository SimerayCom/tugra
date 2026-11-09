import { HostResolverService, normalizeHost } from "./host-resolver.service";

type App = { id: string; teamId: string; serverId: string; domain: string | null; extraDomains: string[]; domainRedirect: string | null };
type Svc = { hostname: string; applicationId: string; serverId: string };

function make(apps: App[], svcs: Svc[] = []) {
  const prisma = {
    application: {
      // honours the `where: { serverId }` the resolver must pass — that is the isolation under test
      findMany: jest.fn(({ where }: any) => Promise.resolve(apps.filter((a) => a.serverId === where.serverId))),
    },
    appServiceDomain: {
      findMany: jest.fn(({ where }: any) => {
        const sid = where.application.serverId;
        const onServer = new Set(apps.filter((a) => a.serverId === sid).map((a) => a.id));
        return Promise.resolve(svcs.filter((s) => onServer.has(s.applicationId)));
      }),
    },
  } as any;
  return { resolver: new HostResolverService(prisma), prisma };
}
const app = (o: Partial<App> & { id: string }): App => ({ teamId: "tA", serverId: "s1", domain: null, extraDomains: [], domainRedirect: null, ...o });

describe("normalizeHost", () => {
  it("lowercases, strips port and trailing dot", () => {
    expect(normalizeHost("Example.COM:8443")).toBe("example.com");
    expect(normalizeHost("example.com.")).toBe("example.com");
    expect(normalizeHost("[::1]:80")).toBe("[::1]");
    expect(normalizeHost("  A.b  ")).toBe("a.b");
    expect(normalizeHost(undefined)).toBe("");
    expect(normalizeHost(42)).toBe("");
  });
});

describe("HostResolverService", () => {
  it("resolves the primary domain, case/port/trailing-dot insensitively on both sides", async () => {
    const { resolver } = make([app({ id: "a1", domain: "Shop.Example.com." })]);
    const map = await resolver.forServer("s1");
    expect(resolver.resolve(map, "SHOP.example.com:443")).toEqual({ appId: "a1", teamId: "tA" });
  });

  it("resolves extra domains (aliases)", async () => {
    const { resolver } = make([app({ id: "a1", domain: "a.com", extraDomains: ["Alias.A.com", "other.org"] })]);
    const map = await resolver.forServer("s1");
    expect(resolver.resolve(map, "alias.a.com")?.appId).toBe("a1");
    expect(resolver.resolve(map, "other.org")?.appId).toBe("a1");
  });

  it("with a canonical redirect set, matches both the bare and the www host", async () => {
    const www = make([app({ id: "a1", domain: "www.a.com", domainRedirect: "www" })]);
    const m1 = await www.resolver.forServer("s1");
    expect(www.resolver.resolve(m1, "a.com")?.appId).toBe("a1");
    expect(www.resolver.resolve(m1, "www.a.com")?.appId).toBe("a1");
    const root = make([app({ id: "a2", domain: "b.com", domainRedirect: "root" })]);
    const m2 = await root.resolver.forServer("s1");
    expect(root.resolver.resolve(m2, "www.b.com")?.appId).toBe("a2");
  });

  it("without a redirect, the www twin is NOT claimed", async () => {
    const { resolver } = make([app({ id: "a1", domain: "a.com" })]);
    const map = await resolver.forServer("s1");
    expect(resolver.resolve(map, "www.a.com")).toBeNull();
  });

  it("resolves per-service compose hostnames", async () => {
    const { resolver } = make([app({ id: "a1", domain: "a.com" })], [{ hostname: "Api.a.com", applicationId: "a1", serverId: "s1" }]);
    const map = await resolver.forServer("s1");
    expect(resolver.resolve(map, "api.a.com")).toEqual({ appId: "a1", teamId: "tA" });
  });

  it("an unknown host is unmatched (null)", async () => {
    const { resolver } = make([app({ id: "a1", domain: "a.com" })]);
    const map = await resolver.forServer("s1");
    expect(resolver.resolve(map, "nope.com")).toBeNull();
  });

  it("is scoped to the reporting server: a host owned by another team on ANOTHER server is not attributed", async () => {
    const { resolver, prisma } = make([
      app({ id: "aA", teamId: "tA", serverId: "s1", domain: "a.com" }),
      app({ id: "aB", teamId: "tB", serverId: "s2", domain: "victim.com" }),
    ]);
    const map = await resolver.forServer("s1"); // team A's server reports "victim.com"
    expect(resolver.resolve(map, "victim.com")).toBeNull();
    expect(prisma.application.findMany.mock.calls[0][0].where).toEqual({ serverId: "s1" });
    expect(prisma.appServiceDomain.findMany.mock.calls[0][0].where).toEqual({ application: { serverId: "s1" } });
    // and the owner's own server does attribute it
    expect(resolver.resolve(await resolver.forServer("s2"), "victim.com")).toEqual({ appId: "aB", teamId: "tB" });
  });

  it("a primary domain wins over another app's alias of the same host (deterministic precedence)", async () => {
    const { resolver } = make([
      app({ id: "a1", domain: "x.com", extraDomains: ["shared.com"] }),
      app({ id: "a2", domain: "shared.com" }),
    ]);
    expect(resolver.resolve(await resolver.forServer("s1"), "shared.com")?.appId).toBe("a2");
  });

  it("caches per server within the TTL", async () => {
    const { resolver, prisma } = make([app({ id: "a1", domain: "a.com" })]);
    await resolver.forServer("s1");
    await resolver.forServer("s1");
    expect(prisma.application.findMany).toHaveBeenCalledTimes(1);
    await resolver.forServer("s2");
    expect(prisma.application.findMany).toHaveBeenCalledTimes(2);
  });
});

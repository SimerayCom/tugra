import { ForbiddenException } from "@nestjs/common";
import { TrafficController } from "./traffic.controller";
import { TrafficQuerySchema, TrafficPathsQuerySchema, TrafficCountriesQuerySchema, TrafficBreakdownQuerySchema } from "./dto";

function make(visible: { id: string }[]) {
  const servers = { listForUser: jest.fn().mockResolvedValue(visible) } as any;
  const traffic = {
    domains: jest.fn().mockResolvedValue([]),
    summary: jest.fn().mockResolvedValue({}),
    paths: jest.fn().mockResolvedValue({}),
    countries: jest.fn().mockResolvedValue({}),
    breakdown: jest.fn().mockResolvedValue({}),
  } as any;
  const access = { requireResourceAccess: jest.fn().mockResolvedValue(undefined) } as any;
  const prisma = { application: { findUnique: jest.fn().mockResolvedValue(null) } } as any;
  const resolver = { forServer: jest.fn().mockResolvedValue(new Map()) } as any;
  return { ctrl: new TrafficController(servers, traffic, access, prisma, resolver), servers, traffic, access, prisma, resolver };
}
const user = { userId: "u1" } as any;

describe("TrafficController AUTHZ", () => {
  it("every endpoint resolves the caller's visible servers via listForUser and passes ONLY those ids", async () => {
    const { ctrl, servers, traffic } = make([{ id: "s1" }, { id: "s2" }]);
    await ctrl.domains(user, { teamId: "t1", range: "7d" });
    await ctrl.summary(user, { teamId: "t1", range: "1h", domain: "a.com" });
    await ctrl.paths(user, { teamId: "t1", range: "1h", domain: "a.com", limit: 5 });
    await ctrl.countries(user, { teamId: "t1", range: "1h", domain: "a.com", limit: 5 });
    await ctrl.breakdown(user, { teamId: "t1", dim: "os", range: "1h", domain: "a.com", limit: 5 });
    expect(servers.listForUser).toHaveBeenCalledTimes(5);
    for (const c of servers.listForUser.mock.calls) expect(c).toEqual(["u1", { teamId: "t1" }]);
    expect(traffic.domains).toHaveBeenCalledWith(["s1", "s2"], "7d");
    expect(traffic.summary).toHaveBeenCalledWith(["s1", "s2"], "1h", "a.com");
    expect(traffic.paths).toHaveBeenCalledWith(["s1", "s2"], "1h", "a.com", 5);
    expect(traffic.countries).toHaveBeenCalledWith(["s1", "s2"], "1h", "a.com", 5);
    expect(traffic.breakdown).toHaveBeenCalledWith(["s1", "s2"], "os", "1h", "a.com", 5);
  });

  it("a user who can see no server (e.g. a foreign ?teamId) gets an empty id set — nothing to read", async () => {
    const { ctrl, traffic } = make([]);
    await ctrl.summary(user, { teamId: "someone-elses-team" });
    expect(traffic.summary.mock.calls[0][0]).toEqual([]);
  });

  it("a caller-supplied serverId in the query is not a thing: the id set comes only from listForUser", async () => {
    const { ctrl, traffic } = make([{ id: "mine" }]);
    await ctrl.paths(user, { serverId: "victim", domain: "x.com" } as any);
    expect(traffic.paths.mock.calls[0][0]).toEqual(["mine"]);
  });
});

describe("TrafficController appId scope", () => {
  const APP = { id: "app1", teamId: "t1", serverId: "s1", environmentId: "e1" };
  // The resolver map is the server-wide host -> owner map (first writer wins); app2 owns a shared alias.
  const HOSTS = new Map([
    ["app1.example.com", { appId: "app1", teamId: "t1" }],
    ["alias.example.com", { appId: "app1", teamId: "t1" }],
    ["api.example.com", { appId: "app1", teamId: "t1" }],
    ["shared.example.com", { appId: "app2", teamId: "t1" }],
    ["other.example.com", { appId: "app2", teamId: "t1" }],
  ]);
  const setup = (over: { visible?: { id: string }[]; app?: unknown; hosts?: Map<string, { appId: string; teamId: string }> } = {}) => {
    const m = make(over.visible ?? [{ id: "s1" }, { id: "s2" }]);
    m.prisma.application.findUnique.mockResolvedValue("app" in over ? over.app : APP);
    m.resolver.forServer.mockResolvedValue(over.hosts ?? HOSTS);
    return m;
  };

  it("filters to exactly the hosts the resolver attributes to that app, on that app's server only", async () => {
    const { ctrl, traffic, resolver, access } = setup();
    await ctrl.summary(user, { appId: "app1", range: "24h" });
    expect(resolver.forServer).toHaveBeenCalledWith("s1");
    const [ids, range, domain] = traffic.summary.mock.calls[0];
    expect(ids).toEqual(["s1"]);
    expect(range).toBe("24h");
    expect([...domain].sort()).toEqual(["alias.example.com", "api.example.com", "app1.example.com"]); // never app2's hosts
    expect(access.requireResourceAccess).toHaveBeenCalledWith("u1", "t1", expect.objectContaining({ resourceId: "app1" }));
  });

  it("applies to paths, countries and breakdown with their own extra arguments", async () => {
    const { ctrl, traffic } = setup();
    await ctrl.paths(user, { appId: "app1", limit: 5 });
    await ctrl.countries(user, { appId: "app1", limit: 7 });
    await ctrl.breakdown(user, { appId: "app1", dim: "os", limit: 9 });
    expect(traffic.paths.mock.calls[0][0]).toEqual(["s1"]);
    expect(traffic.paths.mock.calls[0][3]).toBe(5);
    expect(traffic.countries.mock.calls[0][3]).toBe(7);
    expect(traffic.breakdown.mock.calls[0][1]).toBe("os");
    expect(traffic.breakdown.mock.calls[0][4]).toBe(9);
    for (const c of [traffic.paths.mock.calls[0][2], traffic.countries.mock.calls[0][2], traffic.breakdown.mock.calls[0][3]]) expect(c).not.toContain("shared.example.com");
  });

  it("an invisible or foreign app gives an empty scope (same outcome as a missing one, nothing is read)", async () => {
    const foreign = setup({ visible: [{ id: "s9" }] }); // the app's server is not in the caller's visible set
    await foreign.ctrl.summary(user, { appId: "app1" });
    expect(foreign.traffic.summary.mock.calls[0][0]).toEqual([]);
    expect(foreign.access.requireResourceAccess).not.toHaveBeenCalled();
    expect(foreign.resolver.forServer).not.toHaveBeenCalled();
    const missing = setup({ app: null });
    await missing.ctrl.summary(user, { appId: "nope" });
    expect(missing.traffic.summary.mock.calls[0][0]).toEqual([]);
  });

  it("a scoped member without a grant gets 403 and nothing is read", async () => {
    const { ctrl, traffic, access } = setup();
    access.requireResourceAccess.mockRejectedValue(new ForbiddenException("no access to this resource"));
    await expect(ctrl.summary(user, { appId: "app1" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(traffic.summary).not.toHaveBeenCalled();
  });

  it("an app with no resolvable hosts passes EMPTY server ids, never an unfiltered call", async () => {
    const { ctrl, traffic } = setup({ hosts: new Map([["other.example.com", { appId: "app2", teamId: "t1" }]]) });
    await ctrl.summary(user, { appId: "app1" });
    await ctrl.paths(user, { appId: "app1" });
    await ctrl.countries(user, { appId: "app1" });
    await ctrl.breakdown(user, { appId: "app1", dim: "browser" });
    expect(traffic.summary.mock.calls[0][0]).toEqual([]);
    expect(traffic.paths.mock.calls[0][0]).toEqual([]);
    expect(traffic.countries.mock.calls[0][0]).toEqual([]);
    expect(traffic.breakdown.mock.calls[0][0]).toEqual([]);
  });

  it("domain narrows within the app's hosts (normalised); a domain outside the set gives an empty scope", async () => {
    const { ctrl, traffic } = setup();
    await ctrl.summary(user, { appId: "app1", domain: "Alias.Example.com:443" });
    expect(traffic.summary.mock.calls[0][0]).toEqual(["s1"]);
    expect(traffic.summary.mock.calls[0][2]).toEqual(["alias.example.com"]);
    await ctrl.summary(user, { appId: "app1", domain: "shared.example.com" }); // owned by app2
    expect(traffic.summary.mock.calls[1][0]).toEqual([]);
    await ctrl.summary(user, { appId: "app1", domain: "unrelated.com" });
    expect(traffic.summary.mock.calls[2][0]).toEqual([]);
  });

  it("without appId nothing changes: no app lookup, no resolver, the caller's domain passes straight through", async () => {
    const { ctrl, traffic, prisma, resolver, access } = setup();
    await ctrl.summary(user, { teamId: "t1", domain: "a.com" });
    expect(traffic.summary).toHaveBeenCalledWith(["s1", "s2"], undefined, "a.com");
    expect(prisma.application.findUnique).not.toHaveBeenCalled();
    expect(resolver.forServer).not.toHaveBeenCalled();
    expect(access.requireResourceAccess).not.toHaveBeenCalled();
  });

  it("the appId query field is validated", () => {
    expect(TrafficQuerySchema.safeParse({ appId: "x" }).success).toBe(true);
    expect(TrafficQuerySchema.safeParse({ appId: "" }).success).toBe(false);
    expect(TrafficPathsQuerySchema.safeParse({ appId: "x", limit: "5" }).success).toBe(true);
  });
});

describe("traffic query DTOs", () => {
  it("accepts the MetricsRange tokens and rejects anything else", () => {
    for (const r of ["1h", "6h", "24h", "7d", "30d"]) expect(TrafficQuerySchema.safeParse({ range: r }).success).toBe(true);
    expect(TrafficQuerySchema.safeParse({ range: "90d" }).success).toBe(false);
    expect(TrafficQuerySchema.safeParse({ range: "constructor" }).success).toBe(false);
  });
  it("coerces and bounds the paths limit", () => {
    expect(TrafficPathsQuerySchema.parse({ limit: "10" }).limit).toBe(10);
    expect(TrafficPathsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(TrafficPathsQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });
  it("coerces and bounds the countries limit", () => {
    expect(TrafficCountriesQuerySchema.parse({ limit: "10" }).limit).toBe(10);
    expect(TrafficCountriesQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(TrafficCountriesQuerySchema.safeParse({ limit: "251" }).success).toBe(false);
    expect(TrafficCountriesQuerySchema.safeParse({ range: "90d" }).success).toBe(false);
  });
  it("validates the breakdown dimension and bounds its limit", () => {
    for (const dim of ["browser", "os", "device", "referrer", "city", "network"]) expect(TrafficBreakdownQuerySchema.safeParse({ dim }).success).toBe(true);
    for (const dim of [undefined, "", "country", "path", "constructor", "BROWSER"]) expect(TrafficBreakdownQuerySchema.safeParse({ dim }).success).toBe(false);
    expect(TrafficBreakdownQuerySchema.parse({ dim: "os", limit: "10" }).limit).toBe(10);
    expect(TrafficBreakdownQuerySchema.safeParse({ dim: "os", limit: "0" }).success).toBe(false);
    expect(TrafficBreakdownQuerySchema.safeParse({ dim: "os", limit: "101" }).success).toBe(false);
    expect(TrafficBreakdownQuerySchema.safeParse({ dim: "os", range: "90d" }).success).toBe(false);
  });
});

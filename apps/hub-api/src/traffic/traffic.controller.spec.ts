import { TrafficController } from "./traffic.controller";
import { TrafficQuerySchema, TrafficPathsQuerySchema, TrafficCountriesQuerySchema } from "./dto";

function make(visible: { id: string }[]) {
  const servers = { listForUser: jest.fn().mockResolvedValue(visible) } as any;
  const traffic = {
    domains: jest.fn().mockResolvedValue([]),
    summary: jest.fn().mockResolvedValue({}),
    paths: jest.fn().mockResolvedValue({}),
    countries: jest.fn().mockResolvedValue({}),
  } as any;
  return { ctrl: new TrafficController(servers, traffic), servers, traffic };
}
const user = { userId: "u1" } as any;

describe("TrafficController AUTHZ", () => {
  it("every endpoint resolves the caller's visible servers via listForUser and passes ONLY those ids", async () => {
    const { ctrl, servers, traffic } = make([{ id: "s1" }, { id: "s2" }]);
    await ctrl.domains(user, { teamId: "t1", range: "7d" });
    await ctrl.summary(user, { teamId: "t1", range: "1h", domain: "a.com" });
    await ctrl.paths(user, { teamId: "t1", range: "1h", domain: "a.com", limit: 5 });
    await ctrl.countries(user, { teamId: "t1", range: "1h", domain: "a.com", limit: 5 });
    expect(servers.listForUser).toHaveBeenCalledTimes(4);
    for (const c of servers.listForUser.mock.calls) expect(c).toEqual(["u1", { teamId: "t1" }]);
    expect(traffic.domains).toHaveBeenCalledWith(["s1", "s2"], "7d");
    expect(traffic.summary).toHaveBeenCalledWith(["s1", "s2"], "1h", "a.com");
    expect(traffic.paths).toHaveBeenCalledWith(["s1", "s2"], "1h", "a.com", 5);
    expect(traffic.countries).toHaveBeenCalledWith(["s1", "s2"], "1h", "a.com", 5);
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
});

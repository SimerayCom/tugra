import { ReadCoalescer } from "../common/read-coalescer";
import { FleetController } from "./fleet.controller";
import { ContainerMetricsService } from "../metrics/container-metrics.service";

// A tiny in-memory ContainerMetric table behind the service's one raw query (newest sample per container, ranked by cpu,
// LIMIT — its SQL values are [serverIds, since, limit]), so the test proves what the controller+service ACTUALLY read —
// a server outside the caller's visible set is never selected, regardless of what rows exist for it. The SQL itself is
// pinned against a real database in test/fleet-metrics.e2e-spec.ts.
const NOW = 1_700_000_000_000;
const row = (serverId: string, containerName: string, cpu: number, ageMs = 1_000) => ({
  serverId, containerName, containerId: "c", ts: new Date(NOW - ageMs), cpu,
  memUsed: 1n, memTotal: 2n, memPct: 50, netRx: 0n, netTx: 0n, blkRead: 0n, blkWrite: 0n,
});
const TABLE = [
  row("mine", "web", 20),
  row("mine", "old", 99, 120_000), // stale (outside the 90s live window)
  row("other-team", "secret-db", 90),
];

function make(visible: { id: string; name: string }[]) {
  const findMany = jest.fn().mockImplementation(({ values: [ids, since, limit] }: { values: [string[], Date, number] }) => {
    const live = TABLE.filter((r) => ids.includes(r.serverId) && r.ts >= since).sort((a, b) => b.ts.getTime() - a.ts.getTime());
    const newest = new Map<string, (typeof TABLE)[number]>();
    for (const r of live) if (!newest.has(`${r.serverId}\0${r.containerName}`)) newest.set(`${r.serverId}\0${r.containerName}`, r);
    return Promise.resolve([...newest.values()].sort((a, b) => b.cpu - a.cpu).slice(0, limit));
  });
  const prisma = {
    $queryRaw: findMany,
    application: { findMany: jest.fn().mockResolvedValue([]) },
    database: { findMany: jest.fn().mockResolvedValue([]) },
    containerLabel: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
  const servers = { listForUser: jest.fn().mockResolvedValue(visible) } as any;
  const ctrl = new FleetController({} as any, {} as any, servers, {} as any, new ContainerMetricsService(prisma), new ReadCoalescer());
  return { ctrl, servers, findMany };
}

describe("FleetController.hottestContainers", () => {
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it("AUTHZ: only returns containers from servers listForUser says the caller can see", async () => {
    const { ctrl, servers, findMany } = make([{ id: "mine", name: "my-server" }]);
    const out = await ctrl.hottestContainers({ userId: "u1" } as any);
    expect(servers.listForUser).toHaveBeenCalledWith("u1", { teamId: undefined, status: undefined, q: undefined });
    expect(findMany.mock.calls[0][0].values[0]).toEqual(["mine"]);
    expect(out.map((r) => r.containerName)).toEqual(["web"]);
    expect(out.some((r) => r.serverId === "other-team")).toBe(false);
  });

  it("AUTHZ: a caller with no visible servers gets nothing and the table is never read", async () => {
    const { ctrl, findMany } = make([]);
    expect(await ctrl.hottestContainers({ userId: "u2" } as any)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("excludes stale rows (outside the live window) and parses/clamps ?limit", async () => {
    const { ctrl } = make([{ id: "mine", name: "my-server" }, { id: "other-team", name: "x" }]);
    const out = await ctrl.hottestContainers({ userId: "u1" } as any, "1");
    expect(out.map((r) => r.containerName)).toEqual(["secret-db"]); // limit 1 → hottest live; "old" (99%) is stale
    expect(await ctrl.hottestContainers({ userId: "u1" } as any, "abc")).toHaveLength(2); // NaN → default 10
  });
});

describe("FleetController read coalescing", () => {
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it("ISOLATION: two callers with different visible sets never share a cached result", async () => {
    const { ctrl, servers, findMany } = make([]);
    servers.listForUser.mockImplementation((uid: string) =>
      Promise.resolve(uid === "team-a" ? [{ id: "mine", name: "a" }] : [{ id: "other-team", name: "b" }]),
    );
    const [a, b] = await Promise.all([ctrl.hottestContainers({ userId: "team-a" } as any), ctrl.hottestContainers({ userId: "team-b" } as any)]);
    expect(a.map((r) => r.containerName)).toEqual(["web"]);
    expect(b.map((r) => r.containerName)).toEqual(["secret-db"]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("two pollers with the same filter cost ONE server-list read and ONE metrics query", async () => {
    const { ctrl, servers, findMany } = make([{ id: "mine", name: "my-server" }]);
    await Promise.all([ctrl.hottestContainers({ userId: "u1" } as any), ctrl.hottestContainers({ userId: "u1" } as any)]);
    await ctrl.hottestContainers({ userId: "u1" } as any);
    expect(servers.listForUser).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

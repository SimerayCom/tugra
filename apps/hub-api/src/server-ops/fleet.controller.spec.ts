import { FleetController } from "./fleet.controller";
import { ContainerMetricsService } from "../metrics/container-metrics.service";

// A tiny in-memory ContainerMetric table that honours the `serverId: {in}` + `ts: {gte}` filters, so the
// test proves what the controller+service ACTUALLY read — a server outside the caller's visible set is
// never selected, regardless of what rows exist for it.
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
  const findMany = jest.fn().mockImplementation(({ where }: any) =>
    Promise.resolve(
      TABLE.filter((r) => where.serverId.in.includes(r.serverId) && r.ts >= where.ts.gte).sort((a, b) => b.ts.getTime() - a.ts.getTime()),
    ),
  );
  const prisma = {
    containerMetric: { findMany },
    application: { findMany: jest.fn().mockResolvedValue([]) },
    database: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
  const servers = { listForUser: jest.fn().mockResolvedValue(visible) } as any;
  const ctrl = new FleetController({} as any, {} as any, servers, {} as any, new ContainerMetricsService(prisma));
  return { ctrl, servers, findMany };
}

describe("FleetController.hottestContainers", () => {
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it("AUTHZ: only returns containers from servers listForUser says the caller can see", async () => {
    const { ctrl, servers, findMany } = make([{ id: "mine", name: "my-server" }]);
    const out = await ctrl.hottestContainers({ userId: "u1" } as any);
    expect(servers.listForUser).toHaveBeenCalledWith("u1", { teamId: undefined, status: undefined, q: undefined });
    expect(findMany.mock.calls[0][0].where.serverId).toEqual({ in: ["mine"] });
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

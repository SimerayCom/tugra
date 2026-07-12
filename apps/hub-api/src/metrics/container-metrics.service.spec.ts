import { ContainerMetricsService, rangeToMs, sampleEvenly } from "./container-metrics.service";
import type { ContainerMetricsMsg } from "@tugra/shared";

describe("rangeToMs", () => {
  it("maps known ranges to a lookback window", () => {
    const base = Date.now();
    expect(base - rangeToMs("1h").sinceMs).toBeGreaterThanOrEqual(3600_000 - 50);
    expect(base - rangeToMs("6h").sinceMs).toBeGreaterThanOrEqual(6 * 3600_000 - 50);
    expect(rangeToMs("24h").range).toBe("24h");
  });
  it("falls back to 1h for an unknown/missing range (no injection of arbitrary windows)", () => {
    expect(rangeToMs("7d").range).toBe("1h"); // 7d deferred to the rollup slice
    expect(rangeToMs(undefined).range).toBe("1h");
    expect(rangeToMs("'; DROP" as string).range).toBe("1h");
  });
  it("rejects Object.prototype keys (own-property check, not `in`) → never a NaN window", () => {
    for (const k of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      const r = rangeToMs(k);
      expect(r.range).toBe("1h");
      expect(Number.isFinite(r.sinceMs)).toBe(true); // not NaN → no `new Date(NaN)` → no Prisma 500
    }
  });
});

describe("sampleEvenly", () => {
  it("returns the series unchanged when at or below the cap", () => {
    const a = [1, 2, 3];
    expect(sampleEvenly(a, 5)).toBe(a);
  });
  it("down-samples above the cap, keeping first and last", () => {
    const a = Array.from({ length: 1000 }, (_, i) => i);
    const out = sampleEvenly(a, 100);
    expect(out).toHaveLength(100);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(999);
    // monotonic (evenly spaced, non-decreasing)
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
  });
});

describe("ContainerMetricsService", () => {
  function make(findMany?: jest.Mock) {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = { containerMetric: { createMany, findMany: findMany ?? jest.fn().mockResolvedValue([]) } } as any;
    return { svc: new ContainerMetricsService(prisma), createMany, findMany: prisma.containerMetric.findMany };
  }

  function row(over: Partial<Record<string, unknown>> = {}) {
    return {
      containerName: "tugra_app1",
      ts: new Date(1_700_000_000_000),
      cpu: 1.5,
      memUsed: 100n,
      memTotal: 200n,
      memPct: 50,
      netRx: 10n,
      netTx: 20n,
      blkRead: 0n,
      blkWrite: 5n,
      ...over,
    };
  }

  it("forApp: prefix-matches (exact OR startsWith '-'), groups by container, widens BigInt→Number + ts", async () => {
    const findMany = jest.fn().mockResolvedValue([
      row({ containerName: "tugra_app1", netRx: 10n }),
      row({ containerName: "tugra_app1-web-1", netRx: 999n }),
      row({ containerName: "tugra_app1", netRx: 11n }),
    ]);
    const { svc } = make(findMany);
    const out = await svc.forApp("s1", "tugra_app1", 1_699_000_000_000);
    // where clause: exact OR startsWith `${prefix}-`
    const where = findMany.mock.calls[0][0].where;
    expect(where.serverId).toBe("s1");
    expect(where.OR).toEqual([{ containerName: "tugra_app1" }, { containerName: { startsWith: "tugra_app1-" } }]);
    // grouped by name, sorted
    expect(out.containers.map((c) => c.name)).toEqual(["tugra_app1", "tugra_app1-web-1"]);
    const main = out.containers[0];
    expect(main.samples).toHaveLength(2);
    expect(main.samples[0].netRx).toBe(10); // BigInt → Number
    expect(main.samples[0].ts).toBe(1_700_000_000_000); // Date → unix ms
    expect(typeof main.samples[0].memUsed).toBe("number");
  });

  it("forApp: down-samples a huge per-container series to the cap", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => row({ ts: new Date(1_700_000_000_000 + i * 1000) }));
    const { svc } = make(jest.fn().mockResolvedValue(rows));
    const out = await svc.forApp("s1", "tugra_app1", 0);
    expect(out.containers[0].samples.length).toBeLessThanOrEqual(500);
  });

  it("forServer: latest sample per container (all containers, live 90s window), sorted by name", async () => {
    const now = 1_700_000_000_000;
    const findMany = jest.fn().mockResolvedValue([
      row({ containerName: "web", containerId: "old", cpu: 1, ts: new Date(now) }),
      row({ containerName: "db", containerId: "db1", cpu: 9, ts: new Date(now + 500) }),
      row({ containerName: "web", containerId: "new", cpu: 5, ts: new Date(now + 1000) }), // newer web
    ]);
    const { svc } = make(findMany);
    const out = await svc.forServer("s1");
    // window: ts >= now - 90s, scoped to this server
    const where = findMany.mock.calls[0][0].where;
    expect(where.serverId).toBe("s1");
    expect(where.ts.gte).toBeInstanceOf(Date);
    // one row per container, sorted by name; web is the NEWER sample
    expect(out.containers.map((c) => c.name)).toEqual(["db", "web"]);
    const web = out.containers.find((c) => c.name === "web")!;
    expect(web.cpu).toBe(5);
    expect(web.containerId).toBe("new");
    expect(typeof web.netRx).toBe("number"); // BigInt → Number
  });

  it("forServer: empty server → no containers", async () => {
    const { svc } = make(jest.fn().mockResolvedValue([]));
    expect(await svc.forServer("s1")).toEqual({ containers: [] });
  });

  it("maps samples to rows (name→containerName, id→containerId, BigInt-rounded byte fields)", async () => {
    const { svc, createMany } = make();
    const msg: ContainerMetricsMsg = {
      type: "container_metrics",
      ts: 1_700_000_000_000,
      samples: [
        { id: "abc123", name: "web", cpu: 0.15, memUsed: 11_010_048.6, memTotal: 2_040_109_465, memPct: 0.55, netRx: 2000.4, netTx: 0, blkRead: 0, blkWrite: 4000.9 },
      ],
    };
    await svc.ingest("s1", msg);
    expect(createMany).toHaveBeenCalledTimes(1);
    const { data } = createMany.mock.calls[0][0];
    expect(data).toHaveLength(1);
    const row = data[0];
    expect(row.serverId).toBe("s1");
    expect(row.containerName).toBe("web"); // stable key
    expect(row.containerId).toBe("abc123");
    expect(row.ts).toEqual(new Date(1_700_000_000_000)); // agent-supplied timestamp
    expect(row.cpu).toBe(0.15);
    expect(row.memPct).toBe(0.55);
    expect(row.memUsed).toBe(BigInt(11_010_049)); // rounded
    expect(row.netRx).toBe(BigInt(2000)); // rounded
    expect(row.blkWrite).toBe(BigInt(4001)); // rounded
  });

  it("no-ops on an empty batch (no createMany call)", async () => {
    const { svc, createMany } = make();
    await svc.ingest("s1", { type: "container_metrics", ts: 1, samples: [] });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("no-ops when samples is missing", async () => {
    const { svc, createMany } = make();
    await svc.ingest("s1", { type: "container_metrics", ts: 1 } as any);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("clamps non-finite numbers to 0 instead of throwing (RangeError from BigInt(Infinity))", async () => {
    const { svc, createMany } = make();
    const msg: ContainerMetricsMsg = {
      type: "container_metrics",
      ts: 1,
      // A compromised agent: JSON.parse turns 1e400 into Infinity; BigInt(Math.round(Infinity)) throws.
      samples: [
        { id: "x", name: "bad", cpu: Infinity, memUsed: Infinity, memTotal: NaN, memPct: -Infinity, netRx: Infinity, netTx: NaN, blkRead: Infinity, blkWrite: NaN },
      ],
    };
    await expect(svc.ingest("s1", msg)).resolves.toBeUndefined(); // does NOT throw
    const row = createMany.mock.calls[0][0].data[0];
    expect(row.cpu).toBe(0);
    expect(row.memPct).toBe(0);
    expect(row.memUsed).toBe(0n);
    expect(row.memTotal).toBe(0n);
    expect(row.netRx).toBe(0n);
    expect(row.blkWrite).toBe(0n);
  });
});

import { MetricsService } from "./metrics.service";
import type { MetricsSample } from "@tugra/shared";

describe("MetricsService", () => {
  function make(rows: unknown[] = [], rollupRows: unknown[] = []) {
    const create = jest.fn().mockResolvedValue({});
    const findMany = jest.fn().mockResolvedValue(rows);
    const rollupFindMany = jest.fn().mockResolvedValue(rollupRows);
    const publish = jest.fn().mockResolvedValue(0);
    const prisma = { metric: { create, findMany }, metricRollup: { findMany: rollupFindMany } } as any;
    const redis = { client: { publish } } as any;
    return { svc: new MetricsService(prisma, redis), create, findMany, rollupFindMany, publish };
  }

  const sample: MetricsSample = {
    ts: 1_700_000_000_000,
    cpu: 12.5,
    memUsed: 100.4,
    memTotal: 200,
    diskUsed: 10,
    diskTotal: 50,
    netRx: 1024.6,
    netTx: 0,
    diskRead: 2048.5,
    diskWrite: 4096.4,
  };

  it("ingest rounds every byte field to a BigInt (incl. the new disk I/O rates) + publishes", async () => {
    const { svc, create, publish } = make();
    await svc.ingest("s1", sample);
    const data = create.mock.calls[0][0].data;
    expect(data.serverId).toBe("s1");
    expect(data.netRx).toBe(BigInt(1025));
    expect(data.diskRead).toBe(BigInt(2049)); // rounded
    expect(data.diskWrite).toBe(BigInt(4096));
    expect(publish).toHaveBeenCalledWith("metrics:s1", expect.stringContaining("diskRead"));
  });

  it("ingest coerces a non-finite / missing disk rate to 0 instead of throwing (old-agent compat)", async () => {
    const { svc, create } = make();
    // An older agent doesn't send diskRead/diskWrite → undefined; a bad one could send Infinity.
    const legacy = { ...sample, diskRead: undefined, diskWrite: Infinity } as unknown as MetricsSample;
    await expect(svc.ingest("s1", legacy)).resolves.toBeUndefined();
    const data = create.mock.calls[0][0].data;
    expect(data.diskRead).toBe(BigInt(0));
    expect(data.diskWrite).toBe(BigInt(0));
  });

  it("recent widens BigInt disk rates back to Number (oldest-first)", async () => {
    const { svc } = make([
      { ts: new Date(2000), cpu: 1, memUsed: 1n, memTotal: 2n, diskUsed: 0n, diskTotal: 0n, netRx: 0n, netTx: 0n, diskRead: 2049n, diskWrite: 4096n },
      { ts: new Date(1000), cpu: 2, memUsed: 1n, memTotal: 2n, diskUsed: 0n, diskTotal: 0n, netRx: 0n, netTx: 0n, diskRead: 10n, diskWrite: 20n },
    ]);
    const out = await svc.recent("s1", 60);
    expect(out).toHaveLength(2);
    expect(out[0].ts).toBe(1000); // reversed → oldest first
    expect(out[1].diskRead).toBe(2049);
    expect(typeof out[1].diskWrite).toBe("number");
  });

  it("history: within-retention range (≤24h) reads RAW rows (asc by ts), rollups untouched", async () => {
    const { svc, findMany, rollupFindMany } = make([
      { ts: new Date(1000), cpu: 3, memUsed: 1n, memTotal: 2n, diskUsed: 0n, diskTotal: 0n, netRx: 5n, netTx: 0n, diskRead: 1n, diskWrite: 2n },
    ]);
    const out = await svc.history("s1", "1h");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(rollupFindMany).not.toHaveBeenCalled();
    const where = findMany.mock.calls[0][0].where;
    expect(where.serverId).toBe("s1");
    expect(where.ts.gte).toBeInstanceOf(Date);
    expect(findMany.mock.calls[0][0].orderBy).toEqual({ ts: "asc" });
    expect(out).toHaveLength(1);
    expect(out[0].ts).toBe(1000);
    expect(out[0].netRx).toBe(5); // BigInt → Number
  });

  it("history: beyond-retention range (7d) reads ROLLUPS — maps avg*→field, bucket→ts, raw untouched", async () => {
    const { svc, findMany, rollupFindMany } = make(
      [],
      [
        { bucket: new Date(60_000), avgCpu: 2.5, avgMemUsed: 100n, avgMemTotal: 200n, avgDiskUsed: 10n, avgDiskTotal: 50n, avgNetRx: 7n, avgNetTx: 0n, avgDiskRead: 1n, avgDiskWrite: 2n },
      ],
    );
    const out = await svc.history("s1", "7d");
    expect(rollupFindMany).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
    const where = rollupFindMany.mock.calls[0][0].where;
    expect(where.serverId).toBe("s1");
    expect(where.bucket.gte).toBeInstanceOf(Date);
    expect(rollupFindMany.mock.calls[0][0].orderBy).toEqual({ bucket: "asc" });
    expect(out).toHaveLength(1);
    expect(out[0].ts).toBe(60_000); // bucket → ts
    expect(out[0].cpu).toBe(2.5); // avgCpu → cpu
    expect(out[0].memUsed).toBe(100); // avgMemUsed → memUsed (Number)
    expect(out[0].diskRead).toBe(1); // avgDiskRead → diskRead
  });
});

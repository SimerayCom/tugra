import { MetricsService, sanitizeSensors } from "./metrics.service";
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

  it("latestForServers: DISTINCT ON newest per server, BigInt→Number, scoped to the given ids", async () => {
    const { svc, findMany } = make([
      { serverId: "a", ts: new Date(3000), cpu: 10, memUsed: 1n, memTotal: 2n, diskUsed: 4n, diskTotal: 8n, netRx: 0n, netTx: 0n, diskRead: 5n, diskWrite: 6n },
      { serverId: "b", ts: new Date(2000), cpu: 20, memUsed: 1n, memTotal: 2n, diskUsed: 0n, diskTotal: 0n, netRx: 0n, netTx: 0n, diskRead: 0n, diskWrite: 0n },
    ]);
    const out = await svc.latestForServers(["a", "b"]);
    expect(out).toEqual([
      { serverId: "a", sample: expect.objectContaining({ ts: 3000, cpu: 10, diskUsed: 4, diskRead: 5 }) },
      { serverId: "b", sample: expect.objectContaining({ ts: 2000, cpu: 20 }) },
    ]);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where.serverId.in).toEqual(["a", "b"]); // only the caller's authorized ids
    expect(arg.distinct).toEqual(["serverId"]);
    expect(arg.orderBy).toEqual([{ serverId: "asc" }, { ts: "desc" }]); // DISTINCT ON newest
  });

  it("latestForServers: no ids → empty result without hitting the DB", async () => {
    const { svc, findMany } = make();
    expect(await svc.latestForServers([])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("ingest persists sanitized sensor columns + publishes the sanitized wire (never the raw strings)", async () => {
    const { svc, create, publish } = make();
    const withSensors: MetricsSample = {
      ...sample,
      temp: 61.2,
      sensors: { coretemp_core0: 61.2 },
      gpus: [
        { name: "NVIDIA RTX 3060", util: 42, memUsed: 2_000_000, memTotal: 12_000_000, temp: 55, power: 120 },
        { name: "AMD", util: 10, memUsed: 1_000_000, memTotal: 8_000_000, temp: 40 },
      ],
      battery: { percent: 73, state: "Discharging" },
    };
    await svc.ingest("s1", withSensors);
    const data = create.mock.calls[0][0].data;
    expect(data.temp).toBe(61.2);
    expect(data.gpuUtil).toBe(42); // max over GPUs
    expect(data.gpuMemUsed).toBe(3_000_000n); // summed, BigInt
    expect(data.gpuTemp).toBe(55); // max
    expect(data.batteryPct).toBe(73);
    expect(data.batteryState).toBe("Discharging");
    expect(data.detail).toMatchObject({ sensors: { coretemp_core0: 61.2 } });
    const published = JSON.parse(publish.mock.calls[0][1]);
    expect(published.temp).toBe(61.2);
    expect(published.battery).toEqual({ percent: 73, state: "Discharging" });
  });

  it("ingest leaves sensor columns NULL for a legacy/sensorless sample and does not throw", async () => {
    const { svc, create } = make();
    await expect(svc.ingest("s1", sample)).resolves.toBeUndefined();
    const data = create.mock.calls[0][0].data;
    expect(data.temp).toBeNull();
    expect(data.gpuUtil).toBeNull();
    expect(data.batteryPct).toBeNull();
  });

  it("toSample maps NULL sensor columns to absent (not 0), reconstructs GPUs from detail", async () => {
    // recent() reverses the rows (newest-first query → oldest-first result), so list the populated row
    // first here; after the reverse, out[0] is the NULL row and out[1] is the populated one.
    const { svc } = make([
      { ts: new Date(2000), cpu: 1, memUsed: 1n, memTotal: 2n, diskUsed: 0n, diskTotal: 0n, netRx: 0n, netTx: 0n, diskRead: 0n, diskWrite: 0n, temp: 50, batteryPct: 80, batteryState: "Full", gpuUtil: 30, gpuMemUsed: 5n, gpuMemTotal: 10n, gpuTemp: 44, detail: { gpus: [{ name: "GPU0", util: 30, memUsed: 5, memTotal: 10, temp: 44 }] } },
      { ts: new Date(1000), cpu: 1, memUsed: 1n, memTotal: 2n, diskUsed: 0n, diskTotal: 0n, netRx: 0n, netTx: 0n, diskRead: 0n, diskWrite: 0n, temp: null, batteryPct: null, gpuUtil: null, detail: null },
    ]);
    const out = await svc.recent("s1", 60);
    expect(out[0].temp).toBeUndefined(); // NULL → absent, renders "—"
    expect(out[0].battery).toBeUndefined();
    expect(out[0].gpus).toBeUndefined();
    expect(out[1].temp).toBe(50);
    expect(out[1].battery).toEqual({ percent: 80, state: "Full" });
    expect(out[1].gpus).toEqual([{ name: "GPU0", util: 30, memUsed: 5, memTotal: 10, temp: 44 }]);
  });

  it("sanitizeSensors clamps hostile input (huge temp, 20 GPUs, util 500, giant name, pct -5)", () => {
    const hostile = {
      ...sample,
      temp: 1e9,
      gpus: Array.from({ length: 20 }, (_, i) => ({ name: "x".repeat(10_000), util: 500, memUsed: -1, memTotal: Infinity, temp: 1e9, power: -3 })),
      battery: { percent: -5, state: "evil\u0000state".repeat(50) },
    } as unknown as MetricsSample;
    const s = sanitizeSensors(hostile);
    expect(s.temp).toBe(250); // clamped to the upper bound
    const gpus = (s.detail as { gpus: unknown[] }).gpus;
    expect(gpus).toHaveLength(8); // capped
    expect((gpus[0] as { name: string }).name.length).toBe(64); // name sliced
    expect((gpus[0] as { util: number }).util).toBe(100); // util clamped
    expect(s.batteryPct).toBe(0); // clamped to the lower bound
    expect(s.batteryState).toBe("Unknown"); // not in the allowlist → Unknown
  });
});

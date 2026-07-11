import { MetricsService } from "./metrics.service";
import type { MetricsSample } from "@tugra/shared";

describe("MetricsService", () => {
  function make(rows: unknown[] = []) {
    const create = jest.fn().mockResolvedValue({});
    const findMany = jest.fn().mockResolvedValue(rows);
    const publish = jest.fn().mockResolvedValue(0);
    const prisma = { metric: { create, findMany } } as any;
    const redis = { client: { publish } } as any;
    return { svc: new MetricsService(prisma, redis), create, findMany, publish };
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
});

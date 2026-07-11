import { ContainerMetricsService } from "./container-metrics.service";
import type { ContainerMetricsMsg } from "@tugra/shared";

describe("ContainerMetricsService", () => {
  function make() {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = { containerMetric: { createMany } } as any;
    return { svc: new ContainerMetricsService(prisma), createMany };
  }

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

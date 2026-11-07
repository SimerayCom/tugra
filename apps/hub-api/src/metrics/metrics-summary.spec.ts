import { diskPctSeries, statOf, summarizeContainer, summarizeHost } from "./metrics-summary";
import type { HostMetricPoint } from "./metrics.service";

const pt = (over: Partial<HostMetricPoint> = {}): HostMetricPoint => ({
  ts: 1_700_000_000_000, cpu: 10, memUsed: 50, memTotal: 100, diskUsed: 25, diskTotal: 100, netRx: 0, netTx: 0, diskRead: 0, diskWrite: 0, ...over,
});

describe("statOf", () => {
  it("returns current (last) / avg / max, rounded to 1 decimal", () => {
    expect(statOf([10, 20, 33])).toEqual({ current: 33, avg: 21, max: 33 });
  });
  it("widens max with the per-bucket peaks when given (a long-range spike beats the average's max)", () => {
    expect(statOf([10, 12], [10, 97])).toMatchObject({ avg: 11, max: 97 });
  });
  it("empty / non-finite → nulls, never NaN", () => {
    expect(statOf([])).toEqual({ current: null, avg: null, max: null });
    expect(statOf([Number.NaN, undefined as unknown as number])).toEqual({ current: null, avg: null, max: null });
  });
});

describe("diskPctSeries (disk-usage history from the stored diskUsed/diskTotal)", () => {
  it("maps each sample to used/total %, skipping samples with no usable total", () => {
    const out = diskPctSeries([pt({ ts: 1, diskUsed: 25, diskTotal: 100 }), pt({ ts: 2, diskUsed: 5, diskTotal: 0 }), pt({ ts: 3, diskUsed: 50, diskTotal: 100 })]);
    expect(out).toEqual([{ ts: 1, pct: 25 }, { ts: 3, pct: 50 }]);
  });
});

describe("summarizeHost / summarizeContainer", () => {
  it("host: current + range avg/max for cpu, mem %, disk %", () => {
    const s = summarizeHost("30d", [
      pt({ ts: 1_000, cpu: 10, cpuMax: 80, memUsed: 20, diskUsed: 10 }),
      pt({ ts: 2_000, cpu: 20, cpuMax: 30, memUsed: 40, diskUsed: 30 }),
    ]);
    expect(s).toMatchObject({
      range: "30d",
      samples: 2,
      cpu: { current: 20, avg: 15, max: 80 },
      mem: { current: 40, avg: 30, max: 40 },
      disk: { current: 30, avg: 20, max: 30 },
    });
    expect(s.from).toBe(new Date(1_000).toISOString());
  });
  it("host: no samples → nulls", () => {
    expect(summarizeHost("1h", [])).toMatchObject({ samples: 0, from: null, cpu: { current: null }, disk: { max: null } });
  });
  it("container: cpu/mem % + avg network rates", () => {
    const s = summarizeContainer("web", [
      { ts: 1, cpu: 5, memUsed: 1, memTotal: 2, memPct: 50, netRx: 100, netTx: 10, blkRead: 0, blkWrite: 0 },
      { ts: 2, cpu: 15, memUsed: 1, memTotal: 2, memPct: 60, netRx: 300, netTx: 30, blkRead: 0, blkWrite: 0 },
    ]);
    expect(s).toMatchObject({ name: "web", samples: 2, cpu: { avg: 10, max: 15 }, mem: { current: 60 }, netRxBytesPerSec: { avg: 200 } });
  });
});

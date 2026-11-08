import { describe, it, expect } from "vitest";
import { humanizeRateSeries, humanizeRatePair, diskPctSeries } from "./metrics";

describe("humanizeRateSeries", () => {
  it("keeps a small current value in B/s untouched", () => {
    const r = humanizeRateSeries([0, 100, 500]);
    expect(r.unit).toBe("B/s");
    expect(r.data).toEqual([0, 100, 500]);
  });

  it("scales to KB/s when the current value crosses 1024", () => {
    const r = humanizeRateSeries([512, 1024, 2048]);
    expect(r.unit).toBe("KB/s");
    expect(r.data).toEqual([0.5, 1, 2]);
  });

  it("scales to MB/s for a megabyte-per-second current value", () => {
    const r = humanizeRateSeries([1, 2, 5_000_000]);
    expect(r.unit).toBe("MB/s");
    expect(r.data[2]).toBeCloseTo(5_000_000 / (1024 * 1024), 5);
  });

  it("picks the unit from the current value, not a past peak", () => {
    // A 5 MB/s spike earlier, but only 40 KB/s flowing now — must read in KB/s.
    const r = humanizeRateSeries([5_000_000, 4_000_000, 40_960]);
    expect(r.unit).toBe("KB/s");
    expect(r.data[2]).toBe(40);
  });

  it("treats an exact 1024 current value as KB/s", () => {
    const r = humanizeRateSeries([2048, 1024]);
    expect(r.unit).toBe("KB/s");
    expect(r.data).toEqual([2, 1]);
  });

  it("returns an empty series in B/s", () => {
    const r = humanizeRateSeries([]);
    expect(r.unit).toBe("B/s");
    expect(r.data).toEqual([]);
  });

  it("keeps a currently-idle series in B/s", () => {
    const r = humanizeRateSeries([5_000_000, 0]);
    expect(r.unit).toBe("B/s");
    expect(r.data).toEqual([5_000_000, 0]);
  });

  it("does not mutate the input array", () => {
    const input = [2048, 4096];
    humanizeRateSeries(input);
    expect(input).toEqual([2048, 4096]);
  });
});

describe("diskPctSeries (disk-usage history)", () => {
  it("maps stored diskUsed/diskTotal to a % series with an aligned time axis", () => {
    const r = diskPctSeries([
      { ts: 1000, diskUsed: 25, diskTotal: 100 },
      { ts: 2000, diskUsed: 50, diskTotal: 100 },
    ]);
    expect(r.times).toEqual([1000, 2000]);
    expect(r.data).toEqual([25, 50]);
  });
  it("skips samples with no usable total (older live SSE sample / zero / NaN) and keeps times aligned", () => {
    const r = diskPctSeries([
      { ts: 1, diskUsed: 10, diskTotal: 0 },
      { ts: 2, diskUsed: Number.NaN, diskTotal: 100 },
      { ts: 3, diskUsed: 30, diskTotal: 60 },
      { ts: 4, diskUsed: undefined as unknown as number, diskTotal: undefined as unknown as number },
    ]);
    expect(r).toEqual({ times: [3], data: [50] });
  });
  it("clamps to 0–100 and handles empty input", () => {
    expect(diskPctSeries([{ ts: 1, diskUsed: 150, diskTotal: 100 }]).data).toEqual([100]);
    expect(diskPctSeries([])).toEqual({ times: [], data: [] });
  });
});

describe("humanizeRatePair", () => {
  it("scales both series into one shared unit chosen from the larger current value", () => {
    const r = humanizeRatePair([100, 2048], [5_000_000, 1024]);
    expect(r.unit).toBe("KB/s");
    expect(r.a).toEqual([100 / 1024, 2]);
    expect(r.b[1]).toBe(1);
  });

  it("stays in B/s when both are idle and does not mutate inputs", () => {
    const a = [5_000_000, 0];
    const r = humanizeRatePair(a, []);
    expect(r.unit).toBe("B/s");
    expect(r.a).toEqual([5_000_000, 0]);
    expect(r.a).not.toBe(a);
    expect(r.b).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { humanizeRateSeries } from "./metrics";

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

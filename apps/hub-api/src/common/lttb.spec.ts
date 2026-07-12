import { downsampleLTTB } from "./lttb";

const y = (p: { v: number }) => p.v;

describe("downsampleLTTB", () => {
  it("returns the series unchanged when at or below the threshold", () => {
    const a = [{ v: 1 }, { v: 2 }, { v: 3 }];
    expect(downsampleLTTB(a, 5, y)).toBe(a);
    expect(downsampleLTTB(a, 3, y)).toBe(a);
  });

  it("down-samples to EXACTLY the threshold", () => {
    const a = Array.from({ length: 5000 }, (_, i) => ({ v: Math.sin(i / 20) * 100 }));
    const out = downsampleLTTB(a, 1000, y);
    expect(out).toHaveLength(1000);
  });

  it("preserves the first and last points", () => {
    const a = Array.from({ length: 3000 }, (_, i) => ({ v: i, id: i }));
    const out = downsampleLTTB(a, 500, (p) => p.v);
    expect(out[0]).toBe(a[0]);
    expect(out[out.length - 1]).toBe(a[a.length - 1]);
  });

  it("keeps points in monotonic index order (no reordering)", () => {
    const a = Array.from({ length: 4000 }, (_, i) => ({ v: Math.cos(i / 15) * 50, id: i }));
    const out = downsampleLTTB(a, 700, (p) => p.v);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].id).toBeGreaterThan(out[i - 1].id);
    }
  });

  it("keeps a sharp spike (shape preservation) that even-sampling could miss", () => {
    const a = Array.from({ length: 2000 }, (_, i) => ({ v: i === 813 ? 9999 : 1 }));
    const out = downsampleLTTB(a, 200, y);
    expect(out.some((p) => p.v === 9999)).toBe(true); // the spike survives the downsample
  });
});

import { describe, it, expect } from "vitest";
import { equirectangular, heightFor, polygonsToPath, unwrapRing } from "./project";

describe("equirectangular", () => {
  const p = equirectangular(360, 180);
  it("maps the globe corners and centre", () => {
    expect(p.project(0, 0)).toEqual([180, 90]);
    expect(p.project(-180, 90)).toEqual([0, 0]);
    expect(p.project(180, -90)).toEqual([360, 180]);
  });
  it("uses x = (lon+180)/360*W and y = (90-lat)/180*H", () => {
    const q = equirectangular(960, 480);
    expect(q.project(90, 45)).toEqual([720, 120]);
  });
  it("honours a cropped latitude window", () => {
    const q = equirectangular(360, 100, 80, -20);
    expect(q.project(0, 80)).toEqual([180, 0]);
    expect(q.project(0, -20)).toEqual([180, 100]);
    expect(q.project(0, 30)).toEqual([180, 50]);
  });
  it("heightFor keeps degrees square", () => {
    expect(heightFor(360, 90, -90)).toBe(180);
    expect(heightFor(960, 84, -57)).toBe(376);
  });
});

describe("polygonsToPath", () => {
  const p = equirectangular(360, 180);
  it("emits one M/L..Z subpath per ring (outer + hole)", () => {
    const outer = [[0, 0], [10, 0], [10, 10], [0, 0]] as [number, number][];
    const hole = [[2, 2], [3, 2], [3, 3], [2, 2]] as [number, number][];
    expect(polygonsToPath([[outer, hole]], p)).toBe("M180,90L190,90L190,80L180,90ZM182,88L183,88L183,87L182,88Z");
  });
  it("is empty when there is nothing to draw", () => {
    expect(polygonsToPath([], p)).toBe("");
    expect(polygonsToPath([[[[0, 0]]]], p)).toBe("");
  });
  it("rounds to 0.01 units", () => {
    expect(polygonsToPath([[[[0.123456, 0], [1, 0], [0.123456, 0]]]], equirectangular(360, 180))).toBe("M180.12,90L181,90L180.12,90Z");
  });
  it("unwraps an antimeridian-crossing ring and draws the overflow a turn over", () => {
    const ring: [number, number][] = [[170, 0], [180, 0], [-170, 0], [-170, 10], [170, 10], [170, 0]];
    expect(unwrapRing(ring).map(([x]) => x)).toEqual([170, 180, 190, 190, 170, 170]);
    const d = polygonsToPath([[ring]], p);
    expect(d.split("Z").length - 1).toBe(2); // the ring plus its copy shifted by -360
    expect(d).toContain("M350,90L360,90L370,90"); // as unwrapped (x runs past the right edge)
    expect(d).toContain("M-10,90L0,90L10,90"); // the copy that re-enters from the left edge
  });
});

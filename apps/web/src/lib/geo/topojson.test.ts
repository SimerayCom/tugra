import { describe, it, expect } from "vitest";
import world from "./world-countries-110m.json";
import { decodeArcs, decodeFeatures, stitchRing, type Topology } from "./topojson";

// Two squares sharing an edge. Quantised with scale 10 / translate (100, 50); arcs are delta-encoded.
//   arc 0: (0,0) -> (1,0) -> (1,1)        shared edge is arc 1 (up the middle), A uses it forward, B uses it reversed
//   arc 1: (1,1) -> (1,0)   (stored as delta: start (1,1), then (0,-1))
const tiny: Topology = {
  type: "Topology",
  transform: { scale: [10, 10], translate: [100, 50] },
  arcs: [
    [[0, 0], [1, 0], [0, 1]], // (0,0) (1,0) (1,1)
    [[1, 1], [0, -1]], // (1,1) (1,0)
    [[1, 0], [-1, 0], [0, 1]], // (1,0) (0,0) (0,1)
  ],
  objects: {
    land: {
      type: "GeometryCollection",
      geometries: [
        { type: "Polygon", id: "A", properties: { name: "Alpha" }, arcs: [[0, 1]] },
        { type: "MultiPolygon", id: 7, properties: { name: "Beta" }, arcs: [[[~1, 2]], [[2]]] },
        { type: "Polygon", arcs: [[0]] },
        { type: "Point" },
      ],
    },
    single: { type: "Polygon", arcs: [[0]] },
  },
};

describe("decodeArcs", () => {
  it("undoes delta encoding then applies scale + translate", () => {
    expect(decodeArcs(tiny)).toEqual([
      [[100, 50], [110, 50], [110, 60]],
      [[110, 60], [110, 50]],
      [[110, 50], [100, 50], [100, 60]],
    ]);
  });
  it("keeps absolute positions when there is no transform", () => {
    expect(decodeArcs({ arcs: [[[1, 2], [3, 4]]] })).toEqual([[[1, 2], [3, 4]]]);
  });
});

describe("stitchRing", () => {
  const arcs = decodeArcs(tiny);
  it("joins arcs, dropping each later arc's duplicated first point", () => {
    expect(stitchRing([0, 1], arcs)).toEqual([[100, 50], [110, 50], [110, 60], [110, 50]]);
  });
  it("reverses an arc for a negative index (~i)", () => {
    expect(stitchRing([~1, 2], arcs)).toEqual([[110, 50], [110, 60], [100, 50], [100, 60]]);
    expect(stitchRing([~0], arcs)).toEqual([[110, 60], [110, 50], [100, 50]]);
  });
  it("rejects an out-of-range arc", () => {
    expect(() => stitchRing([9], arcs)).toThrow(RangeError);
  });
});

describe("decodeFeatures", () => {
  it("decodes polygons and multipolygons with exact coordinates, ids and properties", () => {
    const f = decodeFeatures(tiny, "land");
    expect(f).toHaveLength(4);
    expect(f[0]).toEqual({ id: "A", properties: { name: "Alpha" }, polygons: [[[[100, 50], [110, 50], [110, 60], [110, 50]]]] });
    expect(f[1].id).toBe("7");
    expect(f[1].polygons).toEqual([
      [[[110, 50], [110, 60], [100, 50], [100, 60]]],
      [[[110, 50], [100, 50], [100, 60]]],
    ]);
    expect("id" in f[2]).toBe(false); // no id on the geometry -> none on the feature
    expect(f[3].polygons).toEqual([]); // a Point has no area
  });
  it("accepts a single geometry object and rejects an unknown object name", () => {
    expect(decodeFeatures(tiny, "single")).toHaveLength(1);
    expect(() => decodeFeatures(tiny, "nope")).toThrow(/nope/);
  });
});

describe("vendored countries-110m", () => {
  const feats = decodeFeatures(world as unknown as Topology, "countries");
  it("decodes 177 features; only the three unnumbered territories lack an id", () => {
    expect(feats).toHaveLength(177);
    const noId = feats.filter((f) => f.id === undefined).map((f) => f.properties.name).sort();
    expect(noId).toEqual(["Kosovo", "N. Cyprus", "Somaliland"]);
    expect(feats.find((f) => f.id === "840")?.properties.name).toBe("United States of America");
  });
  it("yields closed rings with valid lon/lat for every feature", () => {
    for (const f of feats) {
      expect(f.polygons.length).toBeGreaterThan(0);
      for (const poly of f.polygons)
        for (const ring of poly) {
          expect(ring.length).toBeGreaterThanOrEqual(4);
          expect(ring[0]).toEqual(ring[ring.length - 1]);
          for (const [lon, lat] of ring) {
            expect(Math.abs(lon)).toBeLessThanOrEqual(180.0001);
            expect(lat).toBeGreaterThanOrEqual(-90);
            expect(lat).toBeLessThanOrEqual(90);
          }
        }
    }
  });
});

/** Minimal in-house TopoJSON decoder, written from the public TopoJSON specification (v1.0).
 *  Scope: exactly what a country choropleth needs — quantized or absolute arcs, shared-arc stitching (negative indices are
 *  reversed arcs), and Polygon / MultiPolygon geometries inside a GeometryCollection (or a single geometry object). */

export type Position = [number, number];
export type Ring = Position[];

export type Topology = {
  type: "Topology";
  transform?: { scale: [number, number]; translate: [number, number] };
  /** Arcs as stored: delta-encoded integers when `transform` is present, absolute positions otherwise. */
  arcs: number[][][];
  objects: Record<string, TopoGeometry>;
};

export type TopoGeometry = {
  type: string;
  id?: string | number;
  properties?: Record<string, unknown> | null;
  /** Polygon: ring[]; MultiPolygon: polygon[] (ring[]); each ring is a list of arc indices (negative = reversed). */
  arcs?: number[][] | number[][][];
  geometries?: TopoGeometry[];
};

export type DecodedFeature = {
  id?: string;
  properties: Record<string, unknown>;
  /** Always normalised to a list of polygons; each polygon is [outer, ...holes]. */
  polygons: Ring[][];
};

/** Turn the stored arcs into absolute [lon, lat] positions: undo the delta encoding (running sum), then scale + translate. */
export function decodeArcs(topology: Pick<Topology, "arcs" | "transform">): Position[][] {
  const { transform } = topology;
  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([a, b]): Position => {
      if (!transform) return [a, b];
      x += a;
      y += b;
      return [x * transform.scale[0] + transform.translate[0], y * transform.scale[1] + transform.translate[1]];
    });
  });
}

/** Stitch a ring from arc indices. Index i >= 0 is arc i; a negative index n is arc ~n (= -n - 1) traversed in reverse.
 *  Consecutive arcs share their joint point, so every arc after the first drops its leading point. */
export function stitchRing(arcIndexes: number[], arcs: Position[][]): Ring {
  const ring: Ring = [];
  arcIndexes.forEach((idx, n) => {
    const arc = idx < 0 ? arcs[~idx]?.slice().reverse() : arcs[idx];
    if (!arc) throw new RangeError(`topojson: arc index ${idx} out of range`);
    for (let i = n === 0 ? 0 : 1; i < arc.length; i++) ring.push(arc[i]);
  });
  return ring;
}

function polygonsOf(g: TopoGeometry, arcs: Position[][]): Ring[][] {
  if (g.type === "Polygon") return [(g.arcs as number[][]).map((r) => stitchRing(r, arcs))];
  if (g.type === "MultiPolygon") return (g.arcs as number[][][]).map((poly) => poly.map((r) => stitchRing(r, arcs)));
  return []; // points / lines / null geometries carry no area to draw
}

/** Decode the named object of a topology into per-feature polygons. A GeometryCollection yields one feature per member. */
export function decodeFeatures(topology: Topology, objectName: string): DecodedFeature[] {
  const obj = topology.objects[objectName];
  if (!obj) throw new Error(`topojson: no object named "${objectName}"`);
  const arcs = decodeArcs(topology);
  const members = obj.type === "GeometryCollection" ? (obj.geometries ?? []) : [obj];
  return members.map((g) => ({
    ...(g.id !== undefined && g.id !== null ? { id: String(g.id) } : {}),
    properties: g.properties ?? {},
    polygons: polygonsOf(g, arcs),
  }));
}

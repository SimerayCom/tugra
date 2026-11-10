import type { Position, Ring } from "./topojson";

/** Equirectangular (plate carrée) projection from [lon, lat] degrees to SVG user units.
 *  x = (lon + 180) / 360 * width ; y = (latTop - lat) / (latTop - latBottom) * height.
 *  The default latitude window is the whole globe, i.e. y = (90 - lat) / 180 * height. */
export type Projection = {
  width: number;
  height: number;
  project: (lon: number, lat: number) => Position;
};

export function equirectangular(width: number, height: number, latTop = 90, latBottom = -90): Projection {
  const span = latTop - latBottom;
  return {
    width,
    height,
    project: (lon, lat) => [((lon + 180) / 360) * width, ((latTop - lat) / span) * height],
  };
}

/** Height that keeps one degree the same length on both axes for a given width and latitude window. */
export function heightFor(width: number, latTop: number, latBottom: number): number {
  return Math.round(((width / 360) * (latTop - latBottom)) * 100) / 100;
}

const num = (n: number) => String(Math.round(n * 100) / 100); // 0.01 unit is far below a pixel; keeps the path strings small

/** Make longitudes continuous along a ring: where consecutive points jump by more than half the globe the ring crosses the
 *  antimeridian, so the later points are shifted by a whole turn instead of drawing a line across the map. */
export function unwrapRing(ring: Ring): Ring {
  let shift = 0;
  return ring.map(([lon, lat], i): Position => {
    if (i > 0) {
      const d = lon - ring[i - 1][0]; // raw jump between neighbours
      if (d > 180) shift -= 360;
      else if (d < -180) shift += 360;
    }
    return [lon + shift, lat];
  });
}

function ringPath(ring: Ring, p: Projection, dLon: number): string {
  let d = "";
  ring.forEach(([lon, lat], i) => {
    const [x, y] = p.project(lon + dLon, lat);
    d += `${i === 0 ? "M" : "L"}${num(x)},${num(y)}`;
  });
  return `${d}Z`;
}

/** SVG path data for polygons (each [outer, ...holes]): one M/L…Z subpath per ring. A ring that crosses the antimeridian is
 *  unwrapped and drawn a second time one turn over, so both halves land inside the viewBox (the SVG clips the rest).
 *  Empty string when there is nothing to draw. */
export function polygonsToPath(polygons: Ring[][], p: Projection): string {
  let d = "";
  for (const poly of polygons) {
    for (const raw of poly) {
      if (raw.length < 2) continue;
      const ring = unwrapRing(raw);
      let lo = Infinity;
      let hi = -Infinity;
      for (const [lon] of ring) {
        if (lon < lo) lo = lon;
        if (lon > hi) hi = lon;
      }
      d += ringPath(ring, p, 0);
      if (hi > 180) d += ringPath(ring, p, -360);
      if (lo < -180) d += ringPath(ring, p, 360);
    }
  }
  return d;
}

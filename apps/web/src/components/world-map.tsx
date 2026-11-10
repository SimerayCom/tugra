"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
// Bundled at build time (Natural Earth, public domain, via world-atlas): the map NEVER fetches geography at runtime.
import worldTopology from "world-atlas/countries-110m.json";
import { useI18n } from "../i18n/provider";
import { alpha2ToNumeric, numericToAlpha2 } from "../lib/country-codes";
import { countryName } from "../lib/traffic";

const W = 960;
const H = 480;
const STEPS = 5; // sequential bins (legend + fills share them)
const ANTARCTICA = "010"; // no visitors, and it would eat a third of the vertical space
// world-atlas ships Kosovo without an ISO numeric id; GeoIP databases report it as the user-assigned code "XK".
const KOSOVO_FEATURE_NAME = "Kosovo";

const nf = new Intl.NumberFormat("en-US");
const TOUCH_TIP_MS = 4000; // a tap-opened tooltip dismisses itself after this long
const isTouchLike = (e: PointerEvent) => e.pointerType === "touch" || e.pointerType === "pen";

type TopoIn = Parameters<typeof feature>[0] & { objects: Record<string, unknown> };
type TopoObj = Parameters<typeof feature>[1];
type CountryFeature = Feature<Geometry, { name?: string }>;
export type MapShape = { key: string; alpha2: string | null; fallbackName: string; d: string };

let shapesCache: MapShape[] | null = null;
/** Country outlines projected once per page load (pure computation over the bundled topology). */
export function mapShapes(): MapShape[] {
  if (shapesCache) return shapesCache;
  const topo = worldTopology as unknown as TopoIn;
  const fc = feature(topo, topo.objects.countries as TopoObj) as unknown as FeatureCollection<Geometry, { name?: string }>;
  const features: CountryFeature[] = fc.features.filter((f) => String(f.id ?? "").padStart(3, "0") !== ANTARCTICA);
  const projection = geoNaturalEarth1().fitSize([W, H], { type: "FeatureCollection", features });
  const path = geoPath(projection);
  shapesCache = features.flatMap((f, i) => {
    const d = path(f);
    if (!d) return [];
    const name = f.properties?.name ?? "";
    const alpha2 = numericToAlpha2(f.id) ?? (name === KOSOVO_FEATURE_NAME ? "XK" : null);
    return [{ key: `${f.id ?? name}-${i}`, alpha2, fallbackName: name, d }];
  });
  return shapesCache;
}

/** Volume -> 1..STEPS bin on a log scale (request counts are heavy-tailed); 0 for no data. */
export function volumeBin(requests: number, max: number): number {
  if (!Number.isFinite(requests) || requests <= 0 || !Number.isFinite(max) || max <= 0) return 0;
  const t = Math.log1p(requests) / Math.log1p(max);
  return Math.min(STEPS, Math.max(1, Math.ceil(t * STEPS)));
}

// Sequential ramp: neutral land -> the accent token, mixed in the page's own colour space so both themes work.
const LAND = "color-mix(in srgb, var(--c-tx3) 22%, var(--c-sb))";
export function binFill(bin: number): string {
  if (bin <= 0) return LAND;
  const pct = Math.round(20 + (80 * bin) / STEPS); // 36%..100% accent
  return `color-mix(in srgb, var(--c-a) ${pct}%, ${LAND})`;
}

/** Choropleth world map: countries shaded by request volume. Decorative-with-alternative: the ranked country list next to it
 *  carries the same data for assistive tech, so the SVG is aria-hidden. */
export function WorldMap({ rows }: { rows: { country: string; requests: number }[] }) {
  const { t, lang } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string; sticky: boolean } | null>(null);

  const shapes = useMemo(() => mapShapes(), []);
  const { byNumeric, max } = useMemo(() => {
    const m = new Map<string, number>();
    let hi = 0;
    for (const r of rows) {
      const code = (r.country ?? "").trim().toUpperCase();
      const id = alpha2ToNumeric(code) ?? (code === "XK" ? "XK" : null);
      if (!id || !Number.isFinite(r.requests) || r.requests <= 0) continue; // ZZ / unknown / empty: not shaded (still in the list)
      const v = (m.get(id) ?? 0) + r.requests;
      m.set(id, v);
      if (v > hi) hi = v;
    }
    return { byNumeric: m, max: hi };
  }, [rows]);

  const requestsFor = (alpha2: string | null) => (alpha2 ? byNumeric.get(alpha2 === "XK" ? "XK" : (alpha2ToNumeric(alpha2) ?? "")) ?? 0 : 0);

  // Centre the tooltip on the pointer, then clamp its own left edge so it never leaves the wrapper (an overflow to the right
  // would otherwise scroll the page sideways at phone width). Runs before paint, so there is no visible jump.
  useLayoutEffect(() => {
    const el = tipRef.current;
    const box = wrapRef.current?.getBoundingClientRect();
    if (!tip || !el || !box) return;
    const w = el.offsetWidth;
    el.style.left = `${Math.max(0, Math.min(tip.x - w / 2, box.width - w))}px`;
  }, [tip]);

  // Touch/pen: the tooltip persists after release; dismiss on an outside tap or after a timeout.
  const sticky = tip?.sticky ?? false;
  useEffect(() => {
    if (!sticky) return;
    const timer = setTimeout(() => setTip(null), TOUCH_TIP_MS);
    const onDown = (ev: globalThis.PointerEvent) => {
      if (!(ev.target instanceof Element) || !ev.target.closest('[data-testid="world-map-country"]')) setTip(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [sticky, tip?.text]);

  const show = (e: PointerEvent, s: MapShape, touch: boolean) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    const name = (s.alpha2 ? countryName(s.alpha2, lang) : null) ?? s.fallbackName;
    const n = requestsFor(s.alpha2);
    setTip({
      x: Math.min(Math.max(e.clientX - box.left, 0), box.width),
      y: Math.max(e.clientY - box.top, 0),
      sticky: touch,
      text: n > 0 ? t("traffic.mapTooltip", { country: name, n: nf.format(n) }) : t("traffic.mapTooltipNone", { country: name }),
    });
  };

  return (
    <figure aria-label={t("traffic.mapLabel")} data-testid="world-map" style={{ margin: 0, minWidth: 0 }}>
      <div ref={wrapRef} style={{ position: "relative" }} onPointerLeave={(e) => { if (!isTouchLike(e)) setTip(null); }}>
        <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false" style={{ display: "block", width: "100%", height: "auto" }}>
          {shapes.map((s) => {
            const bin = volumeBin(requestsFor(s.alpha2), max);
            return (
              <path
                key={s.key}
                d={s.d}
                data-testid="world-map-country"
                data-country={s.alpha2 ?? undefined}
                data-bin={bin}
                style={{ fill: binFill(bin), stroke: "var(--c-sb)", strokeWidth: 0.6, strokeLinejoin: "round" }}
                onPointerEnter={(e) => { if (!isTouchLike(e)) show(e, s, false); }}
                onPointerMove={(e) => { if (!isTouchLike(e)) show(e, s, false); }}
                onPointerDown={(e) => { if (isTouchLike(e)) show(e, s, true); }}
              />
            );
          })}
        </svg>
        {tip && (
          <div
            ref={tipRef}
            role="presentation"
            data-testid="world-map-tooltip"
            style={{
              position: "absolute",
              left: tip.x,
              top: tip.y,
              transform: "translateY(calc(-100% - 10px))",
              pointerEvents: "none",
              background: "var(--c-el)",
              border: "1px solid var(--c-bd)",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 12,
              color: "var(--c-tx)",
              width: "max-content",
              maxWidth: "100%",
              boxSizing: "border-box",
              boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
              zIndex: 1,
            }}
          >
            {tip.text}
          </div>
        )}
      </div>
      <figcaption aria-hidden="true" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 11, color: "var(--c-tx3)" }}>
        <span>{t("traffic.mapLegendFewer")}</span>
        <span style={{ display: "inline-flex", gap: 2 }}>
          {Array.from({ length: STEPS }, (_, i) => (
            <span key={i} style={{ width: 22, height: 8, borderRadius: 2, background: binFill(i + 1) }} />
          ))}
        </span>
        <span>{max > 0 ? t("traffic.mapLegendMore", { n: nf.format(max) }) : t("traffic.mapLegendNone")}</span>
      </figcaption>
    </figure>
  );
}

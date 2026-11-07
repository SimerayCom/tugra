"use client";

import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useT } from "../i18n/provider";

/** Compact trend line for table rows. `fixedMax` pins the top of the scale (e.g. 100 for a percent series)
 *  so a quiet host reads as a low flat line instead of being stretched to fill the cell. */
export function Sparkline({
  data,
  width = 80,
  height = 24,
  color = "var(--c-a)",
  fixedMax,
  label,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fixedMax?: number;
  label?: string;
}) {
  const clean = data.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return <span style={{ color: "var(--c-tx3)" }}>—</span>;
  const max = fixedMax ?? Math.max(...clean, 1);
  const min = fixedMax !== undefined ? 0 : Math.min(...clean, 0);
  const span = max - min || 1;
  const pts = clean
    .map((v, i) => {
      const x = (i / (clean.length - 1)) * width;
      const y = height - (Math.min(Math.max(v, min), max) - min) / span * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}


// ── pure helpers (exported for tests) ──────────────────────────────────────────────────────────────

/** A "nice" axis ceiling >= `max` (1 / 2 / 2.5 / 5 / 10 × 10^k) so an auto-scaled axis ends on a round
 *  number instead of an arbitrary window max. Non-positive / non-finite input → 1. */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  const f = max / base;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * base;
}

/** Axis number without a unit (the unit lives in the header) — compact so it fits the narrow Y gutter. */
export function fmtAxis(v: number): string {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return Number(v.toFixed(1)).toString();
  return Number(v.toFixed(2)).toString();
}

/** Tick label for the X axis. Short windows show a clock time; medium windows (where several ticks fall on the
 *  same day and clock-only labels would collide, e.g. 24h → "14:05 … 14:05") add the day so each tick is unique;
 *  long windows show a short date. */
export function formatTick(ts: number, spanMs: number): string {
  const d = new Date(ts);
  if (spanMs <= 12 * 3600_000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (spanMs <= 3 * 86400_000) return d.toLocaleString([], { day: "numeric", hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Full timestamp for the tooltip (seconds only when the window is short enough for them to matter). */
export function formatStamp(ts: number, spanMs: number): string {
  const d = new Date(ts);
  if (spanMs <= 2 * 3600_000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Horizontal position (0..width) of each point: time-proportional when valid ascending timestamps are
 *  supplied (so gaps in the series show as gaps), else evenly spaced. A single point sits in the middle. */
export function pointXs(n: number, times: number[] | undefined, width: number): number[] {
  if (n === 0) return [];
  if (n === 1) return [width / 2];
  if (times && times.length === n && times.every((t) => Number.isFinite(t))) {
    const t0 = times[0];
    const span = times[n - 1] - t0;
    if (span > 0) return times.map((t) => Math.min(Math.max(((t - t0) / span) * width, 0), width));
  }
  return Array.from({ length: n }, (_, i) => (i / (n - 1)) * width);
}

/** `count` evenly spaced X-axis ticks across the series' time span: {frac 0..1 along the axis, ts}.
 *  Empty when timestamps are missing/invalid; a single point yields one centred tick. */
export function pickTimeTicks(times: number[] | undefined, count = 4): { frac: number; ts: number }[] {
  if (!times || times.length === 0 || !times.every((t) => Number.isFinite(t))) return [];
  const t0 = times[0];
  const t1 = times[times.length - 1];
  if (times.length === 1 || t1 <= t0) return [{ frac: 0.5, ts: t0 }];
  return Array.from({ length: count }, (_, i) => {
    const frac = i / (count - 1);
    return { frac, ts: t0 + frac * (t1 - t0) };
  });
}

/** Index of the point whose X is closest to `x`. */
export function nearestIndex(xs: number[], x: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const d = Math.abs(xs[i] - x);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Min / average / max of a series (null when empty). */
export function seriesStats(values: number[]): { min: number; avg: number; max: number } | null {
  if (values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, avg: sum / values.length, max };
}

const Y_GUTTER = 34; // px reserved left of the plot for the Y-axis numbers
const PAD = 8; // px of vertical breathing room inside the plot

export function MetricChart({
  data,
  label,
  unit = "%",
  color = "var(--c-a)",
  height = 140,
  decimals = 0,
  times,
  peaks,
}: {
  data: number[];
  label: string;
  unit?: string;
  color?: string;
  height?: number;
  decimals?: number;
  /** Unix-ms timestamp per point (same length as `data`) → enables the time X-axis + timestamped tooltip. */
  times?: number[];
  /** Optional per-point PEAK (same length as `data`, e.g. the stored per-minute max CPU of a 7d/30d rollup
   *  read) → drawn as a faint band above the average line. */
  peaks?: number[];
}) {
  const t = useT();
  const width = 600;
  const uid = useId().replace(/:/g, ""); // colons in useId break an SVG url(#…) reference
  const [active, setActive] = useState<number | null>(null);

  // Sanitize: a series may carry undefined/NaN (e.g. an older agent that omits a newer metric field,
  // whose live SSE sample reaches the chart unmapped). Coerce to 0 so `.toFixed()` and the SVG path
  // never see a non-finite value and crash the whole tab.
  const clean = useMemo(() => data.map((v) => (Number.isFinite(v) ? v : 0)), [data]);
  const n = clean.length;
  const cleanPeaks = useMemo(
    () => (peaks && peaks.length === n ? peaks.map((v, i) => (Number.isFinite(v) ? Math.max(v, clean[i]) : clean[i])) : undefined),
    [peaks, clean, n],
  );
  const validTimes = times && times.length === n && times.every((x) => Number.isFinite(x)) ? times : undefined;
  const spanMs = validTimes && n > 1 ? validTimes[n - 1] - validTimes[0] : 0;

  const last = n ? clean[n - 1] : 0;
  // Y scale: percent metrics are ALWAYS 0–100 so an idle series sits LOW with the frame visible (the Beszel
  // look); every other unit (rates, bytes) auto-scales to a round ceiling over the window's max (peaks included).
  const isPct = unit === "%";
  const dataMax = Math.max(...clean, ...(cleanPeaks ?? []), 0);
  // Percent axes sit at 0–100 so an idle series reads low against a visible frame — but container CPU is a
  // per-core docker stat that exceeds 100% on multi-core hosts, so a percent series ABOVE 100 auto-extends to a
  // round ceiling instead of clipping.
  const axisMax = isPct ? (dataMax > 100 ? niceMax(dataMax) : 100) : niceMax(dataMax);
  const plotH = height - PAD * 2;
  const yOf = (v: number) => PAD + (1 - Math.min(Math.max(v, 0), axisMax) / axisMax) * plotH;
  const baseY = PAD + plotH;
  const xs = useMemo(() => pointXs(n, validTimes, width), [n, validTimes]);
  const pts = clean.map((v, i) => `${xs[i].toFixed(1)},${yOf(v).toFixed(1)}`);
  const line = pts.join(" ");
  const area = n > 1 ? `M ${xs[0].toFixed(1)},${baseY} ${pts.map((p) => `L ${p}`).join(" ")} L ${xs[n - 1].toFixed(1)},${baseY} Z` : "";
  const band =
    cleanPeaks && n > 1
      ? `M ${cleanPeaks.map((v, i) => `${xs[i].toFixed(1)},${yOf(v).toFixed(1)}`).join(" L ")} L ${clean
          .map((v, i) => `${xs[i].toFixed(1)},${yOf(v).toFixed(1)}`)
          .reverse()
          .join(" L ")} Z`
      : "";
  const gridFracs = [0, 0.25, 0.5, 0.75, 1];
  const stats = useMemo(() => seriesStats(clean), [clean]);
  const ticks = useMemo(() => pickTimeTicks(validTimes), [validTimes]);
  const fmt = (v: number) => `${v.toFixed(decimals)}${unit}`;

  const idx = active !== null && active < n ? active : null;
  const hoverFrac = idx !== null ? xs[idx] / width : 0;
  const stamp = (i: number) => (validTimes ? formatStamp(validTimes[i], spanMs) : "");
  const valueText = (i: number) => {
    const base = fmt(clean[i]);
    const peak = cleanPeaks && cleanPeaks[i] > clean[i] ? ` · ${t("charts.peak")} ${fmt(cleanPeaks[i])}` : "";
    return validTimes ? `${base}${peak} · ${stamp(i)}` : `${base}${peak}`;
  };

  const moveToClientX = (e: PointerEvent<HTMLDivElement>) => {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    setActive(nearestIndex(xs, frac * width));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (n === 0) return;
    const step = e.shiftKey ? 10 : 1;
    const cur = idx ?? n - 1;
    let next: number | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(cur - step, 0);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(cur + step, n - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") {
      setActive(null);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };

  return (
    <div
      style={{
        background: "var(--c-sb)",
        border: "1px solid var(--c-bd)",
        borderRadius: "var(--r2)",
        padding: 16,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, gap: 8 }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 13, color: "var(--c-tx2)" }}>{label}</span>
          <span style={{ fontSize: 10, color: "var(--c-tx3)" }} className="mono">
            {axisMax.toFixed(decimals)}
            {unit}
          </span>
        </span>
        <span style={{ fontSize: 18, fontWeight: 700, color }} className="mono">
          {last.toFixed(decimals)}
          {unit}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <div aria-hidden="true" style={{ position: "relative", width: Y_GUTTER, height, flexShrink: 0 }}>
          {[0, 0.5, 1].map((f) => (
            <span
              key={f}
              className="mono"
              style={{ position: "absolute", right: 0, top: PAD + f * plotH - 6, fontSize: 9.5, lineHeight: "12px", color: "var(--c-tx3)" }}
            >
              {fmtAxis(axisMax * (1 - f))}
            </span>
          ))}
        </div>
        <div
          role="slider"
          tabIndex={0}
          aria-label={label}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.max(n - 1, 0)}
          aria-valuenow={idx ?? Math.max(n - 1, 0)}
          aria-valuetext={n === 0 ? t("charts.noData") : valueText(idx ?? n - 1)}
          onPointerMove={moveToClientX}
          onPointerDown={moveToClientX}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") setActive(null);
          }}
          onFocus={() => setActive((a) => a ?? (n ? n - 1 : null))}
          onBlur={() => setActive(null)}
          onKeyDown={onKeyDown}
          style={{ position: "relative", flex: 1, minWidth: 0, height, touchAction: "pan-y", cursor: n ? "crosshair" : "default", borderRadius: 4 }}
        >
          <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block", height }} aria-hidden="true">
            <defs>
              <linearGradient id={`g${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <rect x={0} y={0} width={width} height={height} fill="color-mix(in srgb, var(--c-bd) 18%, transparent)" />
            {gridFracs.map((f) => {
              const gy = PAD + f * plotH;
              return <line key={f} x1={0} x2={width} y1={gy} y2={gy} stroke="var(--c-bd)" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" opacity={0.5} />;
            })}
            {band && <path data-testid="chart-peak-band" d={band} fill={color} fillOpacity={0.14} stroke="none" />}
            {area && <path d={area} fill={`url(#g${uid})`} stroke="none" />}
            {n > 1 && <polyline points={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
            {idx !== null && (
              <line data-testid="chart-crosshair" x1={xs[idx]} x2={xs[idx]} y1={PAD} y2={baseY} stroke="var(--c-tx3)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {n === 1 && idx === null && (
            <span aria-hidden="true" style={{ position: "absolute", left: "50%", top: yOf(clean[0]), width: 8, height: 8, marginLeft: -4, marginTop: -4, borderRadius: "50%", background: color }} />
          )}
          {n === 0 && (
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--c-tx3)" }}>
              {t("charts.noData")}
            </span>
          )}
          {idx !== null && (
            <>
              <span
                aria-hidden="true"
                style={{ position: "absolute", left: `${hoverFrac * 100}%`, top: yOf(clean[idx]), width: 8, height: 8, marginLeft: -4, marginTop: -4, borderRadius: "50%", background: color, border: "2px solid var(--c-sb)", boxSizing: "content-box", pointerEvents: "none" }}
              />
              <div
                data-testid="chart-tooltip"
                style={{
                  position: "absolute",
                  left: `${hoverFrac * 100}%`,
                  top: 0,
                  transform: `translate(${hoverFrac < 0.18 ? "0" : hoverFrac > 0.82 ? "-100%" : "-50%"}, -4px)`,
                  background: "var(--c-el)",
                  border: "1px solid var(--c-bd)",
                  borderRadius: 6,
                  padding: "4px 8px",
                  fontSize: 11,
                  lineHeight: 1.35,
                  whiteSpace: "nowrap",
                  pointerEvents: "none",
                  boxShadow: "0 2px 8px rgba(0,0,0,.25)",
                  zIndex: 2,
                }}
              >
                <div className="mono" style={{ fontWeight: 700, color }}>{fmt(clean[idx])}</div>
                {cleanPeaks && cleanPeaks[idx] > clean[idx] && (
                  <div className="mono" style={{ color: "var(--c-tx2)" }}>{`${t("charts.peak")} ${fmt(cleanPeaks[idx])}`}</div>
                )}
                {validTimes && <div style={{ color: "var(--c-tx3)" }}>{stamp(idx)}</div>}
              </div>
            </>
          )}
        </div>
      </div>
      {ticks.length > 0 && (
        <div aria-hidden="true" data-testid="chart-xaxis" style={{ position: "relative", height: 14, marginTop: 4, marginLeft: Y_GUTTER + 6, overflow: "hidden" }}>
          {ticks.map((tk, i) => (
            <span
              key={i}
              className="mono"
              style={{
                position: "absolute",
                top: 0,
                left: `${tk.frac * 100}%`,
                transform: `translateX(${tk.frac <= 0 ? "0" : tk.frac >= 1 ? "-100%" : "-50%"})`,
                fontSize: 9.5,
                lineHeight: "14px",
                color: "var(--c-tx3)",
                whiteSpace: "nowrap",
              }}
            >
              {formatTick(tk.ts, spanMs)}
            </span>
          ))}
        </div>
      )}
      {stats && (
        <div data-testid="chart-stats" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8, fontSize: 11, color: "var(--c-tx3)" }} className="mono">
          <span>{`${t("charts.min")} ${fmt(stats.min)}`}</span>
          <span>{`${t("charts.avg")} ${fmt(stats.avg)}`}</span>
          <span>{`${t("charts.max")} ${fmt(cleanPeaks ? Math.max(stats.max, ...cleanPeaks) : stats.max)}`}</span>
        </div>
      )}
    </div>
  );
}

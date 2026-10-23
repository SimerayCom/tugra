"use client";

import { useId } from "react";

export function Sparkline({
  data,
  width = 80,
  height = 24,
  color = "var(--c-a)",
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (data.length < 2) return <span style={{ color: "var(--c-tx3)" }}>—</span>;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((v - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
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

export function MetricChart({
  data,
  label,
  unit = "%",
  color = "var(--c-a)",
  height = 140,
  decimals = 0,
}: {
  data: number[];
  label: string;
  unit?: string;
  color?: string;
  height?: number;
  decimals?: number;
}) {
  const width = 600;
  const uid = useId().replace(/:/g, ""); // colons in useId break an SVG url(#…) reference
  // Sanitize: a series may carry undefined/NaN (e.g. an older agent that omits a newer metric field,
  // whose live SSE sample reaches the chart unmapped). Coerce to 0 so `.toFixed()` and the SVG path
  // never see a non-finite value and crash the whole tab.
  const clean = data.map((v) => (Number.isFinite(v) ? v : 0));
  const last = clean.length ? clean[clean.length - 1] : 0;
  // Fixed baseline: percent metrics always scale 0–100, so an idle / near-zero series sits LOW with the
  // frame visible (the Beszel look) instead of being stretched to fill. Rate metrics use the window max.
  const axisMax = unit === "%" ? 100 : Math.max(...clean, 1);
  const baseY = height - 8;
  const pts = clean
    .map((v, i) => {
      const x = (i / Math.max(data.length - 1, 1)) * width;
      const y = height - (v / axisMax) * (height - 16) - 8;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = clean.length ? `M 0,${baseY} ${pts.split(" ").map((p) => `L ${p}`).join(" ")} L ${width},${baseY} Z` : "";
  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((f) => 8 + f * (height - 16));
  return (
    <div
      style={{
        background: "var(--c-sb)",
        border: "1px solid var(--c-bd)",
        borderRadius: "var(--r2)",
        padding: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
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
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block", height }}>
        <defs>
          <linearGradient id={`g${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <rect x={0} y={0} width={width} height={height} fill="color-mix(in srgb, var(--c-bd) 18%, transparent)" />
        {gridYs.map((gy, i) => (
          <line key={i} x1={0} x2={width} y1={gy} y2={gy} stroke="var(--c-bd)" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" opacity={0.5} />
        ))}
        {area && <path d={area} fill={`url(#g${uid})`} stroke="none" />}
        <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

"use client";

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
}: {
  data: number[];
  label: string;
  unit?: string;
  color?: string;
  height?: number;
}) {
  const width = 600;
  const last = data.length ? data[data.length - 1] : 0;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const pts = data
    .map((v, i) => {
      const x = (i / Math.max(data.length - 1, 1)) * width;
      const y = height - ((v - min) / span) * (height - 16) - 8;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
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
        <span style={{ fontSize: 13, color: "var(--c-tx2)" }}>{label}</span>
        <span style={{ fontSize: 18, fontWeight: 700, color }} className="mono">
          {last.toFixed(0)}
          {unit}
        </span>
      </div>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <polyline
          points={pts}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

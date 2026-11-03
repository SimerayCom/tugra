import { TriangleAlert } from "lucide-react";
import type { MetricTone } from "../lib/fleet-view";

const FILL: Record<MetricTone, string> = { ok: "var(--c-g)", warn: "var(--c-am)", crit: "var(--c-r)" };

/**
 * A compact horizontal progress bar + value label, shared by the fleet table and the server-overview
 * live gauges. `value` is 0–100 (clamped); null renders an empty track with a dash and no fill. `stale`
 * greys the fill so a frozen sample never looks live. Presentational + memo-safe.
 */
export function MeterBar({
  value,
  tone = "ok",
  text,
  stale = false,
  label,
  width = 64,
  grow = false,
  showToneIcon = false,
}: {
  value: number | null;
  tone?: MetricTone;
  text: string;
  stale?: boolean;
  label?: string;
  width?: number | string;
  /** Let the bar flex to fill its container (used by the overview gauges) instead of a fixed width. */
  grow?: boolean;
  /** Show a warning glyph next to the value for a warn/crit sample, so severity isn't conveyed by colour
   *  alone (WCAG 1.4.1). Opt-in so existing callers render byte-identically. */
  showToneIcon?: boolean;
}) {
  const w = value === null ? 0 : Math.max(0, Math.min(100, value));
  const fill = stale ? "var(--c-tx3)" : FILL[tone];
  const muted = stale || value === null;
  const toneIcon = showToneIcon && !stale && (tone === "warn" || tone === "crit");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={value ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ flex: grow ? "1 1 0" : "none", width: grow ? undefined : width, minWidth: grow ? 0 : undefined, height: 6, borderRadius: 4, background: "var(--c-bd)", overflow: "hidden" }}
      >
        {value !== null && <div style={{ width: `${w}%`, height: "100%", background: fill, transition: "width .4s" }} />}
      </div>
      {toneIcon && <TriangleAlert size={13} color={FILL[tone]} aria-hidden style={{ flexShrink: 0 }} />}
      <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: muted ? "var(--c-tx3)" : "var(--c-tx2)" }}>{text}</span>
    </div>
  );
}

"use client";

import type { CSSProperties } from "react";
import { useT } from "../i18n/provider";

/**
 * Shimmering loading primitives. All sizing matches the real components in
 * ./ui (Card, stat/resource tiles, list rows) so a skeleton can drop in for
 * the real content without shifting layout. Theme-aware (CSS vars only —
 * never a hardcoded hex) and reduced-motion safe: the shimmer animation
 * itself lives in globals.css under the `.skeleton-shimmer` class, guarded
 * by `@media (prefers-reduced-motion: reduce)`.
 */

/** Base shimmering block — every other primitive here is built from this. */
export function Skeleton({
  width = "100%",
  height = 14,
  radius = "var(--r1)",
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: CSSProperties;
}) {
  return (
    <div
      className="skeleton-shimmer"
      style={{
        width,
        height,
        borderRadius: radius,
        ...style,
      }}
    />
  );
}

/** Stacked shimmering lines (a paragraph placeholder). Last line runs shorter. */
export function SkeletonText({
  lines = 3,
  width,
}: {
  lines?: number;
  width?: number | string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height={12} width={i === lines - 1 ? "60%" : (width ?? "100%")} />
      ))}
    </div>
  );
}

/** Card-shaped container for grouping skeleton children (mirrors Card's shape, not its background). */
export function SkeletonCard({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: "transparent",
        border: "1px solid var(--c-bd)",
        borderRadius: "var(--r2)",
        padding: 16,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Small stat tile placeholder — matches the dashboard resource-count tiles (label + big number). */
export function SkeletonStat() {
  return (
    <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", padding: 18, flex: 1, minWidth: 130 }}>
      <Skeleton height={12} width="55%" style={{ marginBottom: 10 }} />
      <Skeleton height={26} width="40%" />
    </div>
  );
}

/**
 * Horizontal list-row placeholder — status dot + text line + trailing short line, matching list rows.
 * `detailed` matches the two-line rows with a 36px icon tile (apps, projects) so swapping in the real
 * rows doesn't shift the layout.
 */
export function SkeletonRow({ detailed = false }: { detailed?: boolean }) {
  if (detailed) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
        <Skeleton width={36} height={36} radius={8} style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          <Skeleton height={14} width="40%" />
          <Skeleton height={11} width="60%" />
        </div>
        <Skeleton height={12} width={56} style={{ flexShrink: 0 }} />
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px" }}>
      <Skeleton width={8} height={8} radius="50%" style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Skeleton height={14} width="50%" />
      </div>
      <Skeleton height={12} width={40} style={{ flexShrink: 0 }} />
    </div>
  );
}

/** Vertical stack of SkeletonRow, bordered like the real list containers (dividers between rows). */
export function SkeletonTable({ rows = 6, detailed = false }: { rows?: number; detailed?: boolean }) {
  const t = useT();
  return (
    <div role="status" aria-busy="true" aria-label={t("common.loading")} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ borderTop: i === 0 ? "none" : "1px solid var(--c-bd)" }}>
          <SkeletonRow detailed={detailed} />
        </div>
      ))}
    </div>
  );
}

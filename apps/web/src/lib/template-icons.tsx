"use client";

import { useState } from "react";

/**
 * Brand icon for a one-click template, rendered from a vendored SVG in
 * /public/icons (sourced from dashboard-icons). When the file is missing it
 * falls back to a coloured initials monogram (stable colour per slug) rather
 * than a generic glyph, so the catalog still reads as distinct, branded tiles.
 * A light chip keeps brand-coloured SVGs visible on the dark theme.
 */
export function TemplateLogo({
  logo,
  slug,
  name,
  size = 22,
}: {
  logo?: string;
  slug: string;
  name?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    const label = (name ?? slug).replace(/[^a-zA-Z0-9]+/g, " ").trim();
    const initials =
      label.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() ||
      (slug[0] ?? "?").toUpperCase();
    let h = 0;
    for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = h % 360;
    return (
      <span
        aria-label={name ?? slug}
        style={{
          width: size,
          height: size,
          borderRadius: Math.max(4, Math.round(size * 0.22)),
          background: `hsl(${hue} 46% 42%)`,
          color: "#fff",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 700,
          fontSize: Math.round(size * 0.42),
          lineHeight: 1,
          userSelect: "none",
          flexShrink: 0,
        }}
      >
        {initials}
      </span>
    );
  }
  return (
    <img
      src={`/icons/${logo ?? slug}.svg`}
      alt={name ?? slug}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      style={{ objectFit: "contain", display: "block" }}
    />
  );
}

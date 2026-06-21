"use client";

import { useState } from "react";
import { Boxes } from "lucide-react";

/**
 * Brand icon for a one-click template, rendered from a vendored SVG in
 * /public/icons (sourced from dashboard-icons). Falls back to a generic glyph
 * when the file is missing. A light chip keeps brand-coloured SVGs visible on
 * the dark theme.
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
  if (failed) return <Boxes size={size} color="var(--c-a)" />;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size + 10,
        height: size + 10,
        borderRadius: 6,
        background: "#fff",
        flexShrink: 0,
      }}
    >
      <img
        src={`/icons/${logo ?? slug}.svg`}
        alt={name ?? slug}
        width={size}
        height={size}
        onError={() => setFailed(true)}
        style={{ display: "block" }}
      />
    </span>
  );
}

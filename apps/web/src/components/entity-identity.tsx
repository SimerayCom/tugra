"use client";

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { deriveTones, normalizeHex } from "../lib/color";

/**
 * Shared rendering for a team's / project's identity colour: a dot, an icon tile and a text badge. The colour
 * is the user's chosen "#rrggbb"; light and dark tone sets are derived once (lib/color) and exposed as custom
 * props that the `.ent` rules in globals.css switch between per theme. With no (or an invalid) colour every
 * piece falls back to the panel's neutral styling, so uncoloured teams/projects look exactly as before.
 */
export function entityVars(color: string | null | undefined): CSSProperties | undefined {
  const hex = color ? normalizeHex(color) : null;
  if (!hex) return undefined;
  const t = deriveTones(hex);
  return {
    "--ent-solid-l": t.light.solid, "--ent-on-l": t.light.onSolid, "--ent-tint-l": t.light.tint, "--ent-text-l": t.light.text,
    "--ent-solid-d": t.dark.solid, "--ent-on-d": t.dark.onSolid, "--ent-tint-d": t.dark.tint, "--ent-text-d": t.dark.text,
  } as CSSProperties;
}

function useVars(color: string | null | undefined) {
  return useMemo(() => entityVars(color), [color]);
}

/** Small round colour marker (decorative; the name beside it carries the meaning). */
export function EntityDot({ color, size = 9 }: { color: string | null | undefined; size?: number }) {
  const vars = useVars(color);
  if (!vars) return null;
  return <span aria-hidden className="ent" style={{ ...vars, width: size, height: size, borderRadius: "50%", background: "var(--ent-solid)", display: "inline-block", flexShrink: 0 }} />;
}

/**
 * Rounded icon tile. An uploaded icon is shown as-is inside a coloured ring; without an upload the tile is
 * filled with the colour and the fallback glyph takes the readable "on" colour. No colour = the neutral tile.
 */
export function EntityTile({
  color, size, radius = 8, iconUrl, fallback, bordered,
}: {
  color: string | null | undefined;
  size: number;
  radius?: number;
  iconUrl: string | null;
  /** Glyph shown when there is no uploaded icon; it inherits `color` (currentColor). */
  fallback: ReactNode;
  /** Neutral tile gets the card border (the detail-page variant). */
  bordered?: boolean;
}) {
  const vars = useVars(color);
  const base: CSSProperties = { width: size, height: size, borderRadius: radius, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden", boxSizing: "border-box" };
  if (!vars) {
    return (
      <span style={{ ...base, background: bordered ? "var(--c-el)" : "var(--c-tile)", border: bordered ? "1px solid var(--c-bd)" : undefined, color: "var(--c-a)" }}>
        {iconUrl ? <img src={iconUrl} alt="" width={size} height={size} style={{ objectFit: "cover" }} /> : fallback}
      </span>
    );
  }
  return (
    <span className="ent" style={{ ...vars, ...base, background: iconUrl ? "var(--ent-tint)" : "var(--ent-solid)", color: "var(--ent-on)", border: "2px solid var(--ent-solid)" }}>
      {iconUrl ? <img src={iconUrl} alt="" width={size} height={size} style={{ objectFit: "cover" }} /> : fallback}
    </span>
  );
}

/** Pill naming a team/project, tinted with its colour (neutral lapis pill when it has none). */
export function EntityBadge({ color, children }: { color: string | null | undefined; children: ReactNode }) {
  const vars = useVars(color);
  const style: CSSProperties = {
    fontSize: "var(--fs-xs)", fontWeight: 700, letterSpacing: "0.04em", padding: "2px 7px", borderRadius: 6, textTransform: "uppercase",
    display: "inline-flex", alignItems: "center", gap: 5,
  };
  if (!vars) return <span style={{ ...style, background: "color-mix(in srgb, var(--c-lapis) 15%, transparent)", color: "var(--c-lapis)" }}>{children}</span>;
  return (
    <span className="ent" style={{ ...vars, ...style, background: "var(--ent-tint)", color: "var(--ent-text)" }}>
      <EntityDot color={color} size={7} />
      {children}
    </span>
  );
}

/**
 * Colour maths for team / project identity colours: hex parsing, WCAG contrast, light/dark tone derivation and
 * a dominant-colour picker (median-cut quantisation over raw RGBA pixels). Pure functions, no DOM, no libraries.
 */

export type RGB = [number, number, number];

/** Preset swatches offered next to the custom hex field (mid-tone hues that read on both themes). */
export const PRESET_COLORS = [
  "#e5484d", "#f76b15", "#f5a623", "#46a758", "#12a594", "#0091ff", "#3e63dd", "#8e4ec6", "#d6409f", "#6e6e76",
] as const;

/** Normalise "#abc", "abc", "#AABBCC" to lower-case "#aabbcc"; null when it is not a valid hex colour. */
export function normalizeHex(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return `#${h}`;
}

export function hexToRgb(hex: string): RGB {
  const n = normalizeHex(hex) ?? "#000000";
  return [parseInt(n.slice(1, 3), 16), parseInt(n.slice(3, 5), 16), parseInt(n.slice(5, 7), 16)];
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

export function rgbToHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("");
}

/** WCAG 2.x relative luminance (0 black .. 1 white). */
export function luminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours (1 .. 21). */
export function contrastRatio(a: RGB | string, b: RGB | string): number {
  const la = luminance(typeof a === "string" ? hexToRgb(a) : a);
  const lb = luminance(typeof b === "string" ? hexToRgb(b) : b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Linear blend: t=0 gives a, t=1 gives b. */
export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Black or white, whichever reads better on the given fill. */
export function readableOn(fill: RGB | string): "#000000" | "#ffffff" {
  return contrastRatio(fill, "#ffffff") >= contrastRatio(fill, "#000000") ? "#ffffff" : "#000000";
}

/** RGB (0-255) to HSL (h 0-360, s/l 0-1). */
export function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb([h, s, l]: [number, number, number]): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const hn = h / 360;
  return [hue(hn + 1 / 3) * 255, hue(hn) * 255, hue(hn - 1 / 3) * 255];
}

/**
 * Nudge a colour's lightness (keeping hue and saturation) until it reaches `min` contrast on `bg`. Moves
 * away from the background (darker on a light bg, lighter on a dark one). Falls back to black/white.
 */
export function ensureContrast(fg: RGB, bg: RGB, min = 4.5): RGB {
  if (contrastRatio(fg, bg) >= min) return fg;
  const [h, s, l] = rgbToHsl(fg);
  const darken = luminance(bg) > 0.4;
  for (let i = 1; i <= 100; i++) {
    const nl = darken ? l - i / 100 : l + i / 100;
    if (nl < 0 || nl > 1) break;
    const c = hslToRgb([h, s, nl]);
    if (contrastRatio(c, bg) >= min) return c;
  }
  return darken ? [0, 0, 0] : [255, 255, 255];
}

/** The card surfaces our two themes draw badges on (see --c-el / --c-sur in globals.css). */
const SURFACE_LIGHT: RGB = [255, 255, 255];
const SURFACE_DARK: RGB = [23, 23, 31];

export interface ToneSet {
  /** Solid fill for avatar tiles / swatches. */
  solid: string;
  /** Icon or letter colour on `solid` (>= 4.5:1). */
  onSolid: string;
  /** Soft tinted background for badges (a wash of the colour over the theme surface). */
  tint: string;
  /** Text colour on `tint` (>= 4.5:1). */
  text: string;
}

export interface EntityTones {
  light: ToneSet;
  dark: ToneSet;
}

function toneFor(base: RGB, surface: RGB): ToneSet {
  const tint = mixRgb(surface, base, 0.16);
  return {
    solid: rgbToHex(base),
    onSolid: readableOn(base),
    tint: rgbToHex(tint),
    text: rgbToHex(ensureContrast(base, tint, 4.5)),
  };
}

/** Derive the light-theme and dark-theme tones for a chosen identity colour, each guaranteed readable. */
export function deriveTones(hex: string): EntityTones {
  const base = hexToRgb(hex);
  return { light: toneFor(base, SURFACE_LIGHT), dark: toneFor(base, SURFACE_DARK) };
}

/** Lowest contrast the chosen colour reaches as a bare accent on either theme surface (for the UI hint). */
export function accentContrast(hex: string): number {
  const c = hexToRgb(hex);
  return Math.min(contrastRatio(c, SURFACE_LIGHT), contrastRatio(c, SURFACE_DARK));
}

// ── dominant colour (median cut) ──

interface Box {
  px: RGB[];
}

function channelRange(px: RGB[], ch: 0 | 1 | 2): number {
  let lo = 255, hi = 0;
  for (const p of px) {
    if (p[ch] < lo) lo = p[ch];
    if (p[ch] > hi) hi = p[ch];
  }
  return hi - lo;
}

function widestChannel(px: RGB[]): 0 | 1 | 2 {
  const r = channelRange(px, 0), g = channelRange(px, 1), b = channelRange(px, 2);
  return r >= g && r >= b ? 0 : g >= b ? 1 : 2;
}

function average(px: RGB[]): RGB {
  let r = 0, g = 0, b = 0;
  for (const p of px) { r += p[0]; g += p[1]; b += p[2]; }
  const n = px.length || 1;
  return [r / n, g / n, b / n];
}

/**
 * Pick the colour that best represents an image. Transparent and near-white/near-black pixels (backgrounds,
 * outlines) are ignored, the rest is quantised by median cut into up to `buckets` boxes, and the winner is
 * the box with the highest population weighted toward vivid colours (so a big grey field does not beat a
 * smaller, saturated logo mark). Returns null when nothing usable is left (e.g. a fully transparent image).
 * `data` is canvas ImageData RGBA bytes.
 */
export function dominantColor(data: ArrayLike<number>, buckets = 8): string | null {
  const all: RGB[] = [];
  const usable: RGB[] = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 125) continue;
    const px: RGB = [data[i], data[i + 1], data[i + 2]];
    all.push(px);
    const l = rgbToHsl(px)[2];
    if (l > 0.94 || l < 0.06) continue;
    usable.push(px);
  }
  const pool = usable.length >= Math.max(4, all.length * 0.02) ? usable : all;
  if (pool.length === 0) return null;

  const boxes: Box[] = [{ px: pool }];
  while (boxes.length < buckets) {
    // Split the box holding the most pixels that can still be split.
    let idx = -1;
    let best = 0;
    boxes.forEach((b, i) => {
      if (b.px.length > best && b.px.length > 1 && channelRange(b.px, widestChannel(b.px)) > 0) { best = b.px.length; idx = i; }
    });
    if (idx < 0) break;
    const box = boxes[idx];
    const ch = widestChannel(box.px);
    const sorted = [...box.px].sort((a, b) => a[ch] - b[ch]);
    const mid = Math.floor(sorted.length / 2);
    boxes.splice(idx, 1, { px: sorted.slice(0, mid) }, { px: sorted.slice(mid) });
  }

  let winner: RGB = average(boxes[0].px);
  let top = -1;
  for (const b of boxes) {
    if (b.px.length === 0) continue;
    const avg = average(b.px);
    const [, s, l] = rgbToHsl(avg);
    const score = b.px.length * (0.25 + s) * (1 - Math.abs(l - 0.5) * 0.6);
    if (score > top) { top = score; winner = avg; }
  }
  return rgbToHex(winner);
}

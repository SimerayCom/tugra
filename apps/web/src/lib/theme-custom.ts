/**
 * Custom colour theme maths for Settings → Appearance. Pure functions only (no DOM): a preset or a picked
 * accent + surface tint becomes a map of CSS variables written inline on <html data-theme="custom">. The custom
 * theme sits on the dark token set (`:root` in globals.css), so only the accent and the surface ramp change.
 */

export type RGB = { r: number; g: number; b: number };

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isHex(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v);
}

export function hexToRgb(hex: string): RGB {
  return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const h = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function luminance({ r, g, b }: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours, 1 .. 21. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const DARK_INK = "#0d0d11";
const LIGHT_INK = "#ffffff";

/** Text/icon colour to place ON an accent fill: whichever of near-black / white contrasts more. */
export function onAccent(accent: string): string {
  const a = hexToRgb(accent);
  return contrastRatio(a, hexToRgb(DARK_INK)) >= contrastRatio(a, hexToRgb(LIGHT_INK)) ? DARK_INK : LIGHT_INK;
}

function rgbToHsl({ r, g, b }: RGB): { h: number; s: number; l: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** Dark surface ramp carrying the hue of `tint` (saturation is capped so a vivid pick stays a quiet surface). */
export function surfaceRamp(tint: string): { bg: string; sb: string; sur: string; el: string; bd: string } {
  const { h, s } = rgbToHsl(hexToRgb(tint));
  const sat = Math.min(s * 0.55, 0.3);
  const at = (l: number) => rgbToHex(hslToRgb(h, sat, l));
  return { bg: at(0.055), sb: at(0.075), sur: at(0.095), el: at(0.115), bd: at(0.2) };
}

/** Lighten an accent toward white until it reaches `min`:1 contrast on the surface (dark accents are unreadable as text/borders). */
export function readableAccent(accent: string, surface: string, min = 3): string {
  const bg = hexToRgb(surface);
  let c = hexToRgb(accent);
  for (let i = 0; i < 20 && contrastRatio(c, bg) < min; i++) {
    c = { r: c.r + (255 - c.r) * 0.12, g: c.g + (255 - c.g) * 0.12, b: c.b + (255 - c.b) * 0.12 };
  }
  return rgbToHex(c);
}

export type CustomTheme = { preset: string; accent: string; tint: string };

export const CUSTOM_PRESETS: { id: string; accent: string; tint: string }[] = [
  { id: "gold", accent: "#d4af6a", tint: "#6b6b8a" },
  { id: "slate", accent: "#7aa2f7", tint: "#64748b" },
  { id: "forest", accent: "#4ade80", tint: "#4d7c5f" },
  { id: "rose", accent: "#fb7185", tint: "#8b5a6b" },
];

export const DEFAULT_CUSTOM: CustomTheme = { preset: "gold", accent: CUSTOM_PRESETS[0].accent, tint: CUSTOM_PRESETS[0].tint };

/** Every CSS variable a custom theme writes inline — also the list to clear when leaving the custom theme. */
export const CUSTOM_VAR_NAMES = ["--c-a", "--c-ad", "--c-on-a", "--c-bg", "--c-sb", "--c-sur", "--c-el", "--c-bd"] as const;

export function customThemeVars(custom: CustomTheme): Record<string, string> {
  const ramp = surfaceRamp(custom.tint);
  const accent = readableAccent(custom.accent, ramp.bg);
  const { r, g, b } = hexToRgb(accent);
  return {
    "--c-a": accent,
    "--c-ad": `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, 0.15)`,
    "--c-on-a": onAccent(accent),
    "--c-bg": ramp.bg,
    "--c-sb": ramp.sb,
    "--c-sur": ramp.sur,
    "--c-el": ramp.el,
    "--c-bd": ramp.bd,
  };
}

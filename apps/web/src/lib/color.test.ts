import { describe, expect, it } from "vitest";
import {
  contrastRatio, deriveTones, dominantColor, ensureContrast, hexToRgb, normalizeHex, readableOn, rgbToHex, accentContrast,
} from "./color";

/** Build RGBA bytes from [r,g,b,a,count] runs. */
function pixels(...runs: [number, number, number, number, number][]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [r, g, b, a, n] of runs) for (let i = 0; i < n; i++) out.push(r, g, b, a);
  return new Uint8ClampedArray(out);
}

describe("normalizeHex", () => {
  it("expands 3-digit, lowercases and adds the hash", () => {
    expect(normalizeHex("ABC")).toBe("#aabbcc");
    expect(normalizeHex("#A1B2C3")).toBe("#a1b2c3");
    expect(normalizeHex("  #336699 ")).toBe("#336699");
  });
  it("rejects garbage", () => {
    for (const v of ["", "#12", "#12345", "#1234567", "red", "#ggg", "rgb(0,0,0)"]) expect(normalizeHex(v)).toBeNull();
  });
});

describe("contrast", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });
  it("readableOn picks the stronger of black/white", () => {
    expect(readableOn("#ffff00")).toBe("#000000");
    expect(readableOn("#1d2b64")).toBe("#ffffff");
  });
  it("ensureContrast darkens on a light bg and lightens on a dark bg until it passes", () => {
    const onLight = ensureContrast(hexToRgb("#ffe066"), [255, 255, 255], 4.5);
    expect(contrastRatio(onLight, [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
    const onDark = ensureContrast(hexToRgb("#1a1a66"), [23, 23, 31], 4.5);
    expect(contrastRatio(onDark, [23, 23, 31])).toBeGreaterThanOrEqual(4.5);
  });
  it("leaves an already readable colour untouched", () => {
    const c = hexToRgb("#1d2b64");
    expect(ensureContrast(c, [255, 255, 255], 4.5)).toEqual(c);
  });
});

describe("deriveTones", () => {
  it.each(["#ffff00", "#000000", "#ffffff", "#336699", "#e5484d", "#12a594", "#f5a623"])(
    "yields readable text and icon colours in both themes for %s",
    (hex) => {
      const t = deriveTones(hex);
      for (const set of [t.light, t.dark]) {
        expect(contrastRatio(set.text, set.tint)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(set.onSolid, set.solid)).toBeGreaterThanOrEqual(4.5);
        expect(set.solid).toBe(hex);
      }
    },
  );
  it("produces different tints for the light and dark surface", () => {
    const t = deriveTones("#3e63dd");
    expect(t.light.tint).not.toBe(t.dark.tint);
  });
  it("accentContrast reports the weaker of the two themes", () => {
    expect(accentContrast("#ffffff")).toBeCloseTo(1, 1);
    expect(accentContrast("#336699")).toBeGreaterThan(2);
  });
});

describe("dominantColor", () => {
  it("returns the colour of a flat image", () => {
    expect(dominantColor(pixels([51, 102, 153, 255, 200]))).toBe("#336699");
  });
  it("prefers a vivid mark over a bigger neutral field", () => {
    const hex = dominantColor(pixels([128, 128, 128, 255, 300], [229, 72, 77, 255, 150]))!;
    const [r, g, b] = hexToRgb(hex);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(100);
    expect(b).toBeLessThan(100);
  });
  it("ignores transparent pixels and white backgrounds", () => {
    const hex = dominantColor(pixels([0, 0, 0, 0, 500], [255, 255, 255, 255, 400], [0, 145, 255, 255, 120]))!;
    expect(hex).toBe("#0091ff");
  });
  it("returns null for a fully transparent image and for empty input", () => {
    expect(dominantColor(pixels([10, 20, 30, 0, 100]))).toBeNull();
    expect(dominantColor(new Uint8ClampedArray(0))).toBeNull();
  });
  it("falls back to white/black content when that is all there is", () => {
    expect(dominantColor(pixels([255, 255, 255, 255, 50]))).toBe("#ffffff");
  });
  it("splits a two-tone image and picks the more populous vivid half", () => {
    const hex = dominantColor(pixels([0, 145, 255, 255, 300], [247, 107, 21, 255, 100]))!;
    expect(hex).toBe(rgbToHex(hexToRgb("#0091ff")));
  });
});

import { describe, it, expect } from "vitest";
import { contrastRatio, customThemeVars, hexToRgb, isHex, onAccent, readableAccent, surfaceRamp, CUSTOM_PRESETS, luminance } from "./theme-custom";

describe("theme-custom", () => {
  it("validates six-digit hex only", () => {
    expect(isHex("#d4af6a")).toBe(true);
    expect(isHex("#FFF")).toBe(false);
    expect(isHex("red")).toBe(false);
    expect(isHex(undefined)).toBe(false);
  });

  it("onAccent picks dark ink on light accents and white on dark ones, always >= 4.5:1", () => {
    expect(onAccent("#d4af6a")).toBe("#0d0d11"); // gold
    expect(onAccent("#fde047")).toBe("#0d0d11"); // yellow
    expect(onAccent("#1e3a8a")).toBe("#ffffff"); // navy
    expect(onAccent("#7c3aed")).toBe("#ffffff"); // violet
    for (const hex of ["#d4af6a", "#fde047", "#1e3a8a", "#7c3aed", "#ef4444", "#22c55e", "#808080", "#00ffff", "#ff00ff"]) {
      const ink = onAccent(hex);
      expect(contrastRatio(hexToRgb(hex), hexToRgb(ink))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("surface ramp is dark and ascends bg < sb < sur < el < bd", () => {
    for (const tint of ["#6b6b8a", "#ff0000", "#00ff00", "#ffffff", "#000000"]) {
      const r = surfaceRamp(tint);
      const l = [r.bg, r.sb, r.sur, r.el, r.bd].map((h) => luminance(hexToRgb(h)));
      expect(l[0]).toBeLessThan(0.02);
      for (let i = 1; i < l.length; i++) expect(l[i]).toBeGreaterThan(l[i - 1]);
    }
  });

  it("readableAccent lightens a too-dark accent but leaves a readable one alone", () => {
    const bg = surfaceRamp("#6b6b8a").bg;
    expect(readableAccent("#d4af6a", bg)).toBe("#d4af6a");
    const fixed = readableAccent("#1e3a8a", bg);
    expect(fixed).not.toBe("#1e3a8a");
    expect(contrastRatio(hexToRgb(fixed), hexToRgb(bg))).toBeGreaterThanOrEqual(3);
  });

  it("customThemeVars returns the accent, a matching contrast colour and the surface ramp", () => {
    const v = customThemeVars({ preset: "custom", accent: "#d4af6a", tint: "#6b6b8a" });
    expect(Object.keys(v).sort()).toEqual(["--c-a", "--c-ad", "--c-bd", "--c-bg", "--c-el", "--c-on-a", "--c-sb", "--c-sur"]);
    expect(v["--c-a"]).toBe("#d4af6a");
    expect(v["--c-on-a"]).toBe("#0d0d11");
    expect(v["--c-ad"]).toBe("rgba(212, 175, 106, 0.15)");
    // the contrast colour is computed from the accent that is actually applied
    for (const p of CUSTOM_PRESETS) {
      const o = customThemeVars({ preset: p.id, accent: p.accent, tint: p.tint });
      expect(contrastRatio(hexToRgb(o["--c-a"]), hexToRgb(o["--c-on-a"]))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

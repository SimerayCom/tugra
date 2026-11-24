import { describe, it, expect } from "vitest";
import { formatMoney, guideKey, parseMoneyInput, pct, providerName, rescaleActive, rescaleStep, sizeLine } from "./costs";

describe("formatMoney", () => {
  it("drops the decimals of whole amounts and keeps two for the rest", () => {
    expect(formatMoney(599, "EUR")).toBe("€5.99");
    expect(formatMoney(2400, "USD")).toBe("$24");
    expect(formatMoney(0, "EUR")).toBe("€0");
    expect(formatMoney(150050, "EUR")).toBe("€1,500.50");
  });
  it("falls back for an unknown currency code instead of throwing", () => {
    expect(formatMoney(1000, "ZZ")).toContain("10");
  });
});

describe("parseMoneyInput", () => {
  it("accepts plain amounts, a decimal comma and surrounding space", () => {
    expect(parseMoneyInput("12.5")).toBe(12.5);
    expect(parseMoneyInput(" 12,50 ")).toBe(12.5);
    expect(parseMoneyInput("0")).toBe(0);
  });
  it("refuses everything else", () => {
    for (const bad of ["", "abc", "-1", "1.234", "1e3", "12.5.1", "€5"]) expect(parseMoneyInput(bad), bad).toBeNull();
  });
});

describe("provider helpers", () => {
  it("names providers and picks a guide", () => {
    expect(providerName("hetzner")).toBe("Hetzner");
    expect(providerName("mystery")).toBe("mystery");
    expect(providerName(null)).toBeNull();
    expect(guideKey("hetzner")).toBe("hetzner");
    expect(guideKey("aws")).toBe("generic");
    expect(guideKey(null)).toBe("generic");
  });
});

describe("rescale helpers", () => {
  it("orders the steps and knows when a move is running", () => {
    expect(rescaleStep("SHUTTING_DOWN")).toBe(0);
    expect(rescaleStep("DONE")).toBe(3);
    expect(rescaleStep("FAILED")).toBe(-1);
    expect(rescaleActive("RESIZING")).toBe(true);
    expect(rescaleActive("DONE")).toBe(false);
    expect(rescaleActive(undefined)).toBe(false);
  });
});

describe("display helpers", () => {
  it("formats percent and size lines", () => {
    expect(pct(12.4)).toBe("12%");
    expect(pct(-3)).toBe("0%");
    expect(sizeLine(4, 8 * 1024 ** 3, 80 * 1024 ** 3)).toBe("4 vCPU · 8 GB RAM · 80 GB");
    expect(sizeLine(null, null, null)).toBe("");
  });
});

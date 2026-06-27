import { describe, it, expect } from "vitest";
import { resolveTab } from "./tab-param";

describe("resolveTab", () => {
  const keys = ["overview", "configuration", "logs"];
  it("keeps a valid, available tab", () => {
    expect(resolveTab("logs", keys, "overview")).toBe("logs");
  });
  it("falls back when the param is missing", () => {
    expect(resolveTab(null, keys, "overview")).toBe("overview");
    expect(resolveTab(undefined, keys, "overview")).toBe("overview");
    expect(resolveTab("", keys, "overview")).toBe("overview");
  });
  it("falls back when the tab is unknown or unavailable (e.g. a viewer-forbidden tab)", () => {
    expect(resolveTab("bogus", keys, "overview")).toBe("overview");
    expect(resolveTab("settings", ["overview", "backups"], "overview")).toBe("overview");
  });
});

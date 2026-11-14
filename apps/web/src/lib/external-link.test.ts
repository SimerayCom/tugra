import { describe, it, expect } from "vitest";
import { safeExternalUrl } from "./external-link";

describe("safeExternalUrl", () => {
  it("passes http and https URLs", () => {
    expect(safeExternalUrl("https://app.example.com")).toBe("https://app.example.com");
    expect(safeExternalUrl("HTTP://203.0.113.7:8080")).toBe("HTTP://203.0.113.7:8080");
  });
  it("rejects javascript:, data:, relative, protocol-relative and empty values", () => {
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x", "/apps/1", "//evil.example.com", "ftp://x", "", "  ", null, undefined]) {
      expect(safeExternalUrl(bad as string | null | undefined)).toBeNull();
    }
  });
});

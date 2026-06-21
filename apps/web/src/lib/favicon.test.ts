import { describe, it, expect } from "vitest";
import { faviconUrl } from "./favicon";

describe("faviconUrl", () => {
  it("derives the site's own /favicon.ico from an HTTP target", () => {
    expect(faviconUrl("https://example.com/path")).toBe("https://example.com/favicon.ico");
    expect(faviconUrl("http://sub.example.com")).toBe("http://sub.example.com/favicon.ico");
  });

  it("returns empty string for non-URL targets (e.g. host:port)", () => {
    expect(faviconUrl("example.com:5432")).toBe("");
    expect(faviconUrl("")).toBe("");
  });
});

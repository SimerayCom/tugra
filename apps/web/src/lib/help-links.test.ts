import { describe, it, expect } from "vitest";
import { DOCS_URL, SPONSOR_URL, whatsNewUrl } from "./help-links";

describe("whatsNewUrl", () => {
  it("points at the GitHub release of the running version", () => {
    expect(whatsNewUrl("0.1.0-beta.14")).toBe("https://github.com/SimerayCom/tugra/releases/tag/v0.1.0-beta.14");
  });
  it("does not double the v prefix", () => {
    expect(whatsNewUrl("v1.2.3")).toBe("https://github.com/SimerayCom/tugra/releases/tag/v1.2.3");
  });
  it("falls back to the releases index without a version", () => {
    expect(whatsNewUrl(null)).toBe("https://github.com/SimerayCom/tugra/releases");
    expect(whatsNewUrl("  ")).toBe("https://github.com/SimerayCom/tugra/releases");
    expect(whatsNewUrl(undefined)).toBe("https://github.com/SimerayCom/tugra/releases");
  });
  it("exposes the docs and sponsor links", () => {
    expect(DOCS_URL).toBe("https://github.com/SimerayCom/tugra/tree/main/docs");
    expect(SPONSOR_URL).toBe("https://github.com/sponsors/mrcandev");
  });
});

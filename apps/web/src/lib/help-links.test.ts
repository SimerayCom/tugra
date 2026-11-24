import { describe, it, expect } from "vitest";
import { DOCS_URL, GUIDE_IDS, SITE_URL, SPONSOR_URL, guideUrl, whatsNewUrl } from "./help-links";
import { existsSync } from "node:fs";
import path from "node:path";

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
    expect(DOCS_URL).toBe("https://tugra.io/docs");
    expect(SITE_URL).toBe("https://tugra.io");
    expect(SPONSOR_URL).toBe("https://github.com/sponsors/mrcandev");
  });
  it("every guide id has a docs page and a tugra.io/docs URL", () => {
    for (const id of GUIDE_IDS) {
      expect(guideUrl(id)).toBe(`https://tugra.io/docs/${id}`);
      expect(existsSync(path.resolve(__dirname, "../../../../docs", `${id}.md`)), id).toBe(true);
    }
  });
});

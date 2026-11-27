import { describe, it, expect } from "vitest";
import { appLogoProps } from "./app-icon";

const base = { id: "a1", name: "Shop", iconUpdatedAt: null, templateSlug: null, templateLogo: null, source: "IMAGE" as const };

describe("appLogoProps", () => {
  it("builds the upload and favicon URLs on the same origin", () => {
    const p = appLogoProps({ ...base, iconUpdatedAt: "2026-12-10T00:00:00Z", domain: "shop.example.com" });
    expect(p.iconUrl).toBe("/api/v1/apps/a1/icon?v=2026-12-10T00%3A00%3A00Z");
    expect(p.faviconUrl).toBe("/api/v1/apps/a1/favicon?v=shop.example.com");
  });
  it("has no favicon URL for an app without a domain, and never puts a third-party host in a URL", () => {
    const p = appLogoProps({ ...base, domain: null, image: "ghcr.io/acme/api" });
    expect(p.faviconUrl).toBeNull();
    expect(p.iconUrl).toBeNull();
    expect(JSON.stringify(appLogoProps({ ...base, domain: "evil.test" }))).not.toMatch(/https?:\/\//);
  });
  it("passes the picked key and the image along", () => {
    const p = appLogoProps({ ...base, iconKey: "n8n", image: "n8nio/n8n" });
    expect(p.iconKey).toBe("n8n");
    expect(p.image).toBe("n8nio/n8n");
  });
});

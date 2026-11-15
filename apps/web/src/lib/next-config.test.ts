import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config.mjs";

// The generic /api/v1 proxy must be a `fallback` rewrite: Next checks file-system routes (including the dynamic
// streaming route handlers in src/app/api/v1) BEFORE fallback rewrites but AFTER afterFiles rewrites, so placing it in
// afterFiles would let the buffering rewrite shadow those handlers and truncate large uploads again.
describe("next.config rewrites", () => {
  it("keeps the /api/v1 proxy in `fallback`, never in beforeFiles/afterFiles", async () => {
    const r = (await nextConfig.rewrites!()) as unknown as Record<string, { source: string }[]>;
    expect(Array.isArray(r)).toBe(false);
    expect(r.fallback.map((x) => x.source)).toEqual(["/api/v1/:path*"]);
    for (const bucket of ["beforeFiles", "afterFiles"]) {
      expect((r[bucket] ?? []).map((x) => x.source)).not.toContain("/api/v1/:path*");
    }
    expect(r.afterFiles.map((x) => x.source)).toEqual(["/api/auth/oauth/:path*", "/api/auth/oidc/:path*", "/api/auth/oidc"]);
  });
});

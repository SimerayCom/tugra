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

  // "Sign in with GitHub" on the raw two-port install registers `<web origin>/api/auth/oauth/github/callback` with
  // GitHub, so the web port must forward both the start and the callback (query string, Cookie and Set-Cookie forwarding is Next's own rewrite behaviour, checked by hand against a stub hub, not here) to
  // the hub's bare, un-prefixed OAuth routes.
  it("proxies the GitHub OAuth start and callback on the web origin to the hub's bare routes", async () => {
    const prev = process.env.HUB_INTERNAL_URL;
    process.env.HUB_INTERNAL_URL = "http://hub-api:3000";
    try {
      const r = (await nextConfig.rewrites!()) as unknown as Record<string, { source: string; destination: string }[]>;
      const rule = r.afterFiles.find((x) => x.source === "/api/auth/oauth/:path*")!;
      expect(rule.destination).toBe("http://hub-api:3000/auth/oauth/:path*");
      // `:path*` (zero or more segments) covers both `github` (start) and `github/callback`.
    } finally {
      if (prev === undefined) delete process.env.HUB_INTERNAL_URL;
      else process.env.HUB_INTERNAL_URL = prev;
    }
  });
});

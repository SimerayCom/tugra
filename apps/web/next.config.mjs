import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained production output (.next/standalone): the server files plus only the node_modules the build
  // traced, which is what lets the release image ship without the whole workspace. The tracing root is the
  // monorepo root so workspace packages and the hoisted pnpm store are found. Our own server.mjs (not Next's
  // generated server.js) stays the entry point; the image copies it next to the traced output.
  output: "standalone",
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  reactStrictMode: true,
  // Next's default gzip buffers text/event-stream responses proxied through the /api rewrite, which breaks
  // live logs/metrics/update-progress in the quick start. A reverse proxy does compression anyway.
  compress: false,
  transpilePackages: ["@tugra/shared"],
  // Some hub calls are synchronous and long-running by design (PITR enable = preflight + recreate + archive
  // verify; a physical base backup; the restore-verify drill). Next's rewrite proxy would otherwise cut them at
  // its 30s default and the UI would report a failure for an operation that then completes server-side.
  experimental: { proxyTimeout: 600_000 },
  poweredByHeader: false,
  // Clickjacking / MIME-sniffing / referrer hardening for every panel page and proxied API response. The panel
  // is never meant to be framed, so frame-ancestors 'none' (+ the legacy X-Frame-Options for old browsers).
  async headers() {
    return [
      // The service worker must always be revalidated (an update that is not picked up is a stuck old worker) and may
      // control the whole origin even though it is a single file.
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
  // Same-origin proxy: the SPA calls "/api/v1/*" (relative), rewritten to the hub's versioned API so the
  // httpOnly session cookies stay same-origin (SameSite=Lax, no CORS). HUB_INTERNAL_URL is a server-side
  // env (the hub's address reachable from the Next server). OAuth start is exempt from the /api/v1 prefix
  // on the hub (its callback URL is registered externally), so it gets its own bare-path proxy rule.
  async rewrites() {
    const hub = process.env.HUB_INTERNAL_URL ?? "http://localhost:3000";
    return {
      afterFiles: [
        { source: "/api/auth/oauth/:path*", destination: `${hub}/auth/oauth/:path*` },
        // OIDC SSO start/callback are likewise exempt from the /api/v1 prefix (the callback is registered
        // with the external IdP), so they get their own bare-path proxy.
        { source: "/api/auth/oidc/:path*", destination: `${hub}/auth/oidc/:path*` },
        { source: "/api/auth/oidc", destination: `${hub}/auth/oidc` },
      ],
      // The generic API proxy is a `fallback` rewrite so the dynamic route handlers under src/app/api/v1 (the streaming
      // file-upload and agent-transfer routes) take precedence over it: a rewrite buffers the request body in memory and
      // truncates it at 10 MiB (experimental.middlewareClientMaxBodySize), which hangs any larger upload. See
      // src/lib/hub-stream-proxy.ts.
      fallback: [{ source: "/api/v1/:path*", destination: `${hub}/api/v1/:path*` }],
    };
  },
};

export default nextConfig;

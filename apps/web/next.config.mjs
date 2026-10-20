/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next's default gzip buffers text/event-stream responses proxied through the /api rewrite, which breaks
  // live logs/metrics/update-progress in the quick start. A reverse proxy does compression anyway.
  compress: false,
  transpilePackages: ["@tugra/shared"],
  // Same-origin proxy: the SPA calls "/api/v1/*" (relative), rewritten to the hub's versioned API so the
  // httpOnly session cookies stay same-origin (SameSite=Lax, no CORS). HUB_INTERNAL_URL is a server-side
  // env (the hub's address reachable from the Next server). OAuth start is exempt from the /api/v1 prefix
  // on the hub (its callback URL is registered externally), so it gets its own bare-path proxy rule.
  async rewrites() {
    const hub = process.env.HUB_INTERNAL_URL ?? "http://localhost:3000";
    return [
      { source: "/api/v1/:path*", destination: `${hub}/api/v1/:path*` },
      { source: "/api/auth/oauth/:path*", destination: `${hub}/auth/oauth/:path*` },
      // OIDC SSO start/callback are likewise exempt from the /api/v1 prefix (the callback is registered
      // with the external IdP), so they get their own bare-path proxy.
      { source: "/api/auth/oidc/:path*", destination: `${hub}/auth/oidc/:path*` },
      { source: "/api/auth/oidc", destination: `${hub}/auth/oidc` },
    ];
  },
};

export default nextConfig;

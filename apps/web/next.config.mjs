/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
    ];
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@tugra/shared"],
  // Same-origin proxy: the SPA calls "/api/*" (relative), rewritten to the hub. The browser sees a
  // single origin, so the httpOnly session cookies are same-origin (SameSite=Lax works, no CORS).
  // HUB_INTERNAL_URL is a server-side env (the hub's address reachable from the Next server).
  async rewrites() {
    const hub = process.env.HUB_INTERNAL_URL ?? "http://localhost:3000";
    return [{ source: "/api/:path*", destination: `${hub}/:path*` }];
  },
};

export default nextConfig;

import type { MetadataRoute } from "next";

/**
 * Web app manifest, served at /manifest.webmanifest. The panel is one origin (the API is proxied under /api), so it
 * installs as a single app starting at "/" (the root redirects a signed-in user to the dashboard). The icons are the
 * Tugra avatar; the maskable variant keeps the seal inside the 80% safe zone.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Tugra",
    short_name: "Tugra",
    description: "Your seal on every server.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#080809",
    theme_color: "#080809",
    categories: ["productivity", "utilities"],
    icons: [
      { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

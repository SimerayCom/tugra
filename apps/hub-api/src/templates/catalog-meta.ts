/**
 * Curated presentation overlay for the app-store gallery. This is the ONLY place that adds a
 * friendly tagline, search tags, a "featured" flag and capability badges on top of the bulk-imported catalog —
 * the generated JSON (catalog.generated.json) is machine-written and must never be hand-edited. The overlay is
 * keyed by template slug and merged in `templateMetaList`; a `catalog.spec` guard asserts every slug here exists
 * in the catalog, so a typo fails CI rather than silently doing nothing. It carries NO compose/secret data.
 */
export interface TemplateMetaOverlay {
  tagline?: string; // a short, human one-liner shown under the name (not the long description)
  tags?: string[]; // extra search terms (store search matches these)
  featured?: boolean; // show in the Featured shelf (home-cloud flagships)
  badges?: string[]; // curated capability badges, merged with derived ones (see deriveBadges)
}

/** Derive capability badges from the baked compose at BUILD time (never leaks the compose itself). Today: a
 *  "db" badge when the stack bundles a real database engine — so the store can later steer users to Tugra's
 *  managed backups instead of hand-editing live DB data. Redis-only (cache) stacks are intentionally not "db". */
export function deriveBadges(composeFile: string): string[] {
  const badges: string[] = [];
  if (/image:\s*\S*(postgres|mysql|mariadb|mongo)/i.test(composeFile)) badges.push("db");
  return badges;
}

/** ~30 home-cloud + self-host favorites given a polished presentation. Every key MUST be a real catalog slug
 *  (curated or verified-present generated). Keep taglines short; tags drive search, not display. */
export const TEMPLATE_META_OVERLAY: Record<string, TemplateMetaOverlay> = {
  // ── Files, photos & media (the CasaOS home-cloud heartland) ──
  nextcloud: { tagline: "Your private cloud for files, photos & calendar", tags: ["files", "storage", "photos", "office", "sync", "drive"], featured: true },
  immich: { tagline: "Self-hosted Google Photos alternative", tags: ["photos", "backup", "gallery", "media", "google photos"], featured: true },
  jellyfin: { tagline: "Stream your movies, shows & music", tags: ["media", "movies", "tv", "music", "streaming", "plex"], featured: true },
  plex: { tagline: "Media server for movies, TV & music", tags: ["media", "movies", "tv", "streaming"], featured: true },
  "calibre-web": { tagline: "Browse & read your e-book library", tags: ["ebooks", "books", "library", "reading", "media"] },
  audiobookshelf: { tagline: "Audiobook & podcast server", tags: ["audiobooks", "podcasts", "media", "listening"], featured: true },
  navidrome: { tagline: "Your personal music streaming server", tags: ["music", "streaming", "media", "subsonic"] },
  syncthing: { tagline: "Continuous file sync across your devices", tags: ["sync", "files", "backup", "p2p"] },
  photoprism: { tagline: "AI-powered photo gallery, self-hosted", tags: ["photos", "gallery", "ai", "media", "google photos"], featured: true },
  frigate: { tagline: "AI security-camera NVR with object detection", tags: ["cameras", "nvr", "security", "surveillance", "ai"], featured: true },

  // ── Security & network ──
  vaultwarden: { tagline: "Private password manager (Bitwarden-compatible)", tags: ["passwords", "security", "bitwarden", "vault", "secrets"], featured: true },
  "pi-hole": { tagline: "Network-wide ad & tracker blocker", tags: ["dns", "adblock", "network", "privacy", "pihole"], featured: true },
  adguard: { tagline: "Network-wide DNS ad & tracker blocker", tags: ["dns", "adblock", "network", "privacy", "adguard"], featured: true },
  minio: { tagline: "S3-compatible object storage", tags: ["storage", "s3", "objects", "buckets"] },

  // ── Productivity & home ──
  mealie: { tagline: "Recipe manager & meal planner", tags: ["recipes", "cooking", "food", "meal plan"], featured: true },
  actualbudget: { tagline: "Private, local-first budgeting", tags: ["finance", "budget", "money", "expenses"], featured: true },
  freshrss: { tagline: "Self-hosted RSS feed reader", tags: ["rss", "news", "reader", "feeds"] },
  linkding: { tagline: "Minimal self-hosted bookmark manager", tags: ["bookmarks", "links", "productivity", "read later"] },
  excalidraw: { tagline: "Collaborative hand-drawn whiteboard", tags: ["whiteboard", "drawing", "diagrams", "sketch"] },
  "stirling-pdf": { tagline: "All-in-one PDF toolkit", tags: ["pdf", "tools", "documents", "convert"], featured: true },
  "it-tools": { tagline: "Handy developer utilities in one place", tags: ["tools", "developer", "utilities", "converters"] },
  paperless: { tagline: "Scan, index & search all your documents", tags: ["documents", "paperless", "ocr", "scan", "archive"], featured: true },
  "home-assistant": { tagline: "Open-source smart-home control hub", tags: ["smart home", "automation", "iot", "home assistant", "hass"], featured: true },

  // ── Sites, blogs & CMS ──
  wordpress: { tagline: "The world's most popular website & blog platform", tags: ["blog", "website", "cms", "php"], featured: true },
  ghost: { tagline: "Modern publishing & newsletters", tags: ["blog", "publishing", "newsletter", "cms"] },
  wikijs: { tagline: "A modern, powerful wiki", tags: ["wiki", "docs", "knowledge", "notes"] },
  directus: { tagline: "Headless CMS & data platform", tags: ["cms", "headless", "developer", "api"] },

  // ── Automation & monitoring ──
  n8n: { tagline: "Automate anything with visual workflows", tags: ["automation", "workflow", "integrations", "nocode", "zapier"], featured: true },
  "node-red": { tagline: "Low-code event automation", tags: ["automation", "iot", "nocode", "flows"] },
  "uptime-kuma": { tagline: "Beautiful self-hosted uptime monitoring", tags: ["monitoring", "uptime", "status", "alerts"], featured: true },
  grafana: { tagline: "Dashboards for all your metrics", tags: ["monitoring", "dashboards", "metrics", "observability"] },
  umami: { tagline: "Privacy-friendly website analytics", tags: ["analytics", "privacy", "web", "stats"] },
  metabase: { tagline: "No-code BI & dashboards", tags: ["analytics", "bi", "dashboards", "sql"] },

  // ── Developer ──
  gitea: { tagline: "Lightweight self-hosted Git", tags: ["git", "code", "developer", "github"], featured: true },
  portainer: { tagline: "Visual Docker management", tags: ["docker", "containers", "management", "devops"] },
  pocketbase: { tagline: "Instant backend: DB, auth & realtime", tags: ["backend", "database", "developer", "baas"] },
};

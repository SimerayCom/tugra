const REPO = "https://github.com/SimerayCom/tugra";

/** The product site and its docs (the repo's docs/*.md are published under /docs, one page per file name). */
export const SITE_URL = "https://tugra.io";
export const DOCS_URL = `${SITE_URL}/docs`;
export const SPONSOR_URL = "https://github.com/sponsors/mrcandev";

/** The step-by-step guides a screen can point at. The id is the docs page: docs/<id>.md. */
export const GUIDE_IDS = ["connect-github", "move-from-coolify", "move-from-coolify-same-server", "move-off-coolify", "add-a-server", "first-setup", "domains-and-cloudflare"] as const;
export type GuideId = (typeof GUIDE_IDS)[number];

/** The docs page of a guide. Pure. */
export function guideUrl(id: GuideId): string {
  return `${DOCS_URL}/${id}`;
}

/** GitHub release page of the running version; the releases index when the version is unknown. Pure. */
export function whatsNewUrl(version: string | null | undefined): string {
  const v = typeof version === "string" ? version.trim().replace(/^v/i, "") : "";
  return v ? `${REPO}/releases/tag/v${encodeURIComponent(v)}` : `${REPO}/releases`;
}

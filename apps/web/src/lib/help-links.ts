const REPO = "https://github.com/SimerayCom/tugra";

/** In-repo docs (the README's Docs link points at the same place). */
export const DOCS_URL = `${REPO}/tree/main/docs`;
export const SPONSOR_URL = "https://github.com/sponsors/mrcandev";

/** GitHub release page of the running version; the releases index when the version is unknown. Pure. */
export function whatsNewUrl(version: string | null | undefined): string {
  const v = typeof version === "string" ? version.trim().replace(/^v/i, "") : "";
  return v ? `${REPO}/releases/tag/v${encodeURIComponent(v)}` : `${REPO}/releases`;
}

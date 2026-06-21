/**
 * The site's own favicon URL for an HTTP monitor target. We hit the site
 * directly (no third-party favicon service) to keep self-host data private;
 * a broken/missing icon falls back to a glyph in the UI.
 */
export function faviconUrl(target: string): string {
  try {
    const u = new URL(target);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return `${u.origin}/favicon.ico`;
  } catch {
    return "";
  }
}

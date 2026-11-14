/**
 * Returns the URL only when it is a plain http(s) URL, else null. Anything rendered as an `href` that originates
 * from data (an app's domains, ports) goes through this so a `javascript:`, `data:` or relative URL can never
 * become a clickable link.
 */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

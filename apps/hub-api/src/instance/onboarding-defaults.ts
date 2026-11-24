/**
 * Install-time defaults the first-run wizard pre-fills, so the owner confirms instead of retyping values the
 * installer already knew. Pure (no I/O) so the precedence is unit-testable; the settings controller feeds it the
 * env, the request's public host and the owner's email.
 */
export interface OnboardingDefaultsInput {
  envPublicUrl?: string; // HUB_PUBLIC_URL
  panelDomain?: string; // PANEL_DOMAIN (env) or the stored panel domain
  envAcmeEmail?: string; // ACME_EMAIL
  requestUrl?: string; // the origin the owner's browser used (proxy-aware)
  ownerEmail?: string;
}

export interface OnboardingDefaults {
  publicUrl: string | null;
  acmeEmail: string | null;
}

const PLACEHOLDER_DOMAINS = new Set(["example.com", "example.org", "example.net", "example.invalid", "localhost"]);

/** The shipped .env.example carries `admin@example.com`; a placeholder is never a real certificate contact. */
export function isPlaceholderEmail(email: string | undefined | null): boolean {
  const at = (email ?? "").trim().toLowerCase().lastIndexOf("@");
  if (at < 0) return true;
  return PLACEHOLDER_DOMAINS.has((email as string).trim().toLowerCase().slice(at + 1));
}

/** A bare host (no scheme) → https://host; a URL stays itself. Returns null for anything that doesn't parse as http(s). */
function normalizeUrl(raw: string | undefined, bareHostScheme: "https" | "http"): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `${bareHostScheme}://${v}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function suggestOnboardingDefaults(i: OnboardingDefaultsInput): OnboardingDefaults {
  // HUB_PUBLIC_URL is the explicit statement; the panel domain (install --domain) means HTTPS; the request host is
  // the last resort (it is what the owner is looking at right now).
  const publicUrl =
    normalizeUrl(i.envPublicUrl, "https") ?? normalizeUrl(i.panelDomain, "https") ?? normalizeUrl(i.requestUrl, "http");
  const acmeEmail = !isPlaceholderEmail(i.envAcmeEmail) ? (i.envAcmeEmail as string).trim() : !isPlaceholderEmail(i.ownerEmail) ? (i.ownerEmail as string).trim() : null;
  return { publicUrl, acmeEmail };
}

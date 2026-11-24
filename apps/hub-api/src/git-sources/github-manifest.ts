import { createHash, randomBytes } from "node:crypto";

/** How long a manifest / install ticket stays valid. GitHub's own manifest code lives an hour; ours is shorter. */
export const SETUP_TTL_MS = 15 * 60_000;

/** A random, unguessable `state` value (sent to GitHub and echoed back) and the hash we keep. Only the hash is stored. */
export function newSetupState(): { state: string; stateHash: string } {
  const state = randomBytes(32).toString("base64url");
  return { state, stateHash: hashState(state) };
}

export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/** GitHub account / organization login: alphanumerics and single hyphens, at most 39 characters. */
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** A GitHub App name is globally unique and at most 34 characters. */
export function sanitizeAppName(raw: string | undefined, fallbackSuffix: string): string {
  const cleaned = (raw ?? "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 34).trim();
  return cleaned || `Tugra ${fallbackSuffix}`.slice(0, 34);
}

/** Can GitHub reach this origin to deliver webhooks? false for localhost, private ranges and dotless hostnames. */
export function isPubliclyReachable(base: string): boolean {
  let host: string;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return false;
  if (host.startsWith("[")) return !(host === "[::1]" || /^\[(fc|fd|fe80)/.test(host));
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  return host.includes(".");
}

export interface ManifestInput {
  name: string;
  /** Public origin of the hub (webhooks). */
  hubBase: string;
  /** Origin of the panel the browser uses (redirect + setup pages). */
  webBase: string;
  sourceId: string;
  /** Installable on any account / organization (public App) instead of only its owner. */
  anyAccount: boolean;
}

export interface GithubManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  setup_url: string;
  setup_on_update: boolean;
  public: boolean;
  default_permissions: Record<string, "read" | "write">;
  default_events: string[];
}

/** The App Manifest Tugra posts to GitHub: name, least-privilege permissions, the webhook URL for THIS source and the
 *  redirect / setup pages. GitHub generates the webhook secret and private key and hands them back on conversion. */
export function buildManifest(i: ManifestInput): GithubManifest {
  const hub = i.hubBase.replace(/\/+$/, "");
  const web = i.webBase.replace(/\/+$/, "");
  return {
    name: i.name,
    url: web,
    hook_attributes: { url: `${hub}/webhooks/github/${i.sourceId}`, active: isPubliclyReachable(hub) },
    redirect_url: `${web}/sources/github/callback`,
    setup_url: `${web}/sources/github/installed`,
    setup_on_update: false,
    public: i.anyAccount,
    default_permissions: { contents: "read", metadata: "read", pull_requests: "write", statuses: "write" },
    default_events: ["push", "pull_request"],
  };
}

/** The GitHub page that receives the manifest POST: the user's account, or an organization they administer. */
export function manifestPostUrl(org: string | undefined, state: string): string {
  const base = org ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new` : "https://github.com/settings/apps/new";
  return `${base}?state=${encodeURIComponent(state)}`;
}

/** Where the user installs the freshly created App. `state` comes back on the setup URL. */
export function installUrl(slug: string, state: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

import { GuardedHttpGet } from "../importer/sources/guarded-get";
import { assertAllowedUrl } from "../importer/sources/ssrf-guard";

/**
 * Outbound client for the Gitea API family — Gitea, Forgejo and Codeberg (a Forgejo instance) all speak the same
 * `/api/v1`. The instance base URL is USER-SUPPLIED (self-hosted), so every request goes through the importer's
 * SSRF-guarded GET ({@link GuardedHttpGet}): the scheme is validated, the connection is pinned to a DNS-resolved
 * address that is not loopback / link-local / cloud-metadata, and redirects are refused. Nothing here ever builds
 * an error message from the token.
 */

export const TOKEN_GIT_KINDS = ["gitea", "forgejo", "codeberg"] as const;
export type TokenGitKind = (typeof TOKEN_GIT_KINDS)[number];
export const GIT_KINDS = ["github", ...TOKEN_GIT_KINDS] as const;
export type GitKind = (typeof GIT_KINDS)[number];

export const CODEBERG_URL = "https://codeberg.org";

export const isTokenKind = (k: string): k is TokenGitKind => (TOKEN_GIT_KINDS as readonly string[]).includes(k);

/** Page size asked of the instance (Gitea caps it server-side, default 50) and the hard page cap per listing. */
const PAGE_SIZE = 50;
const MAX_PAGES = 10;

export interface GiteaRepo {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string | null;
}

/**
 * Normalise a user-supplied instance base URL: https only (the token travels on every request), no embedded
 * credentials / query / fragment, trailing slash stripped, a pasted `/api/v1` suffix dropped, and the host passed
 * through the SSRF URL check (an IP-literal loopback / link-local / metadata host is refused here, before any
 * request). A sub-path install (https://host/gitea) is kept. Codeberg is fixed to codeberg.org. Throws an Error
 * with a user-facing message.
 */
export function normalizeApiUrl(kind: TokenGitKind, raw?: string | null): string {
  if (kind === "codeberg") {
    if (raw && raw.trim()) {
      const given = safeOrigin(raw);
      if (given !== CODEBERG_URL) throw new Error("a Codeberg source always uses https://codeberg.org — choose Gitea or Forgejo for another host");
    }
    return CODEBERG_URL;
  }
  if (!raw || !raw.trim()) throw new Error("the instance base URL is required (e.g. https://git.example.com)");
  const u = assertAllowedUrl(raw.trim()); // http(s) only, no credentials, blocked IP literals refused
  if (u.protocol !== "https:") throw new Error("the instance base URL must use https (the access token is sent on every request)");
  const path = u.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
  return `${u.origin}${path}`;
}

function safeOrigin(raw: string): string {
  try {
    return new URL(raw.trim()).origin;
  } catch {
    throw new Error("invalid URL");
  }
}

/** The hostname a token source authenticates (used to pin where its token may be sent). */
export function apiUrlHost(apiUrl: string): string {
  return new URL(apiUrl).hostname.toLowerCase();
}

const enc = encodeURIComponent;

/** One SSRF-guarded Gitea-API client bound to an instance + access token. */
export class GiteaClient {
  private readonly http: GuardedHttpGet;

  constructor(apiUrl: string, token: string) {
    const base = new URL(apiUrl);
    const prefix = base.pathname.replace(/\/+$/, ""); // "" or "/gitea" for a sub-path install
    this.http = new GuardedHttpGet(apiUrl, {
      apiPrefix: `${prefix}/api/v1`,
      label: "Gitea",
      headers: () => ({ Authorization: `token ${token}` }),
      errorHint: (status) =>
        status === 401
          ? " (the access token was rejected — check it and that it has not expired)"
          : status === 403
            ? " (the token lacks permission — it needs read access to repositories and the user)"
            : status === 404
              ? " (not found — is the base URL the instance root, and is the repository accessible to this token?)"
              : "",
    });
  }

  /** Validate the token: the authenticated user's login. */
  async whoami(): Promise<string> {
    const me = await this.http.get<{ login?: string; username?: string }>("/user");
    const login = me?.login || me?.username;
    if (!login) throw new Error("Gitea returned no user for this token — is the URL a Gitea/Forgejo instance?");
    return login;
  }

  async listRepos(): Promise<GiteaRepo[]> {
    const out: GiteaRepo[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await this.http.get<
        { full_name: string; clone_url: string; private: boolean; default_branch?: string | null }[]
      >(`/user/repos?limit=${PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(rows)) throw new Error("Gitea returned an unexpected repository list");
      for (const r of rows) {
        out.push({ fullName: r.full_name, cloneUrl: r.clone_url, private: !!r.private, defaultBranch: r.default_branch ?? null });
      }
      if (rows.length === 0) break; // stop on an empty page, not a short one — a server may clamp `limit` below PAGE_SIZE
    }
    return out;
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await this.http.get<{ name: string }[]>(`/repos/${enc(owner)}/${enc(repo)}/branches?limit=${PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(rows)) throw new Error("Gitea returned an unexpected branch list");
      for (const b of rows) out.push(b.name);
      if (rows.length === 0) break; // stop on an empty page, not a short one — a server may clamp `limit` below PAGE_SIZE
    }
    return out;
  }
}

/** Split + validate an `owner/repo` full name (path-segment safe: no empty / dot segments, no extra slashes). */
export function parseRepoFullName(full: string): { owner: string; repo: string } | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)$/.exec(full ?? "");
  if (!m || m[2] === "." || m[2] === ".." || m[1] === "..") return null;
  return { owner: m[1], repo: m[2] };
}

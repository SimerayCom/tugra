import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Pure helpers for verifying incoming git webhooks and deciding whether a push
 * should trigger a deploy. No I/O — fully unit-testable.
 */

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * GitHub-style verification: `X-Hub-Signature-256: sha256=<hex>` is the HMAC-SHA256
 * of the raw request body keyed by the per-app secret.
 */
export function verifyGithubSignature(
  secret: string,
  rawBody: Buffer | string,
  header?: string | null,
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, header);
}

/** GitLab-style verification: `X-Gitlab-Token` equals the per-app secret. */
export function verifyGitlabToken(secret: string, header?: string | null): boolean {
  if (!header) return false;
  return safeEqual(secret, header);
}

/** Gitea/Forgejo verification: `X-Gitea-Signature` / `X-Forgejo-Signature` is the hex HMAC-SHA256 of the
 *  raw body with the per-app secret — same digest as GitHub but WITHOUT the `sha256=` prefix. */
export function verifyGiteaSignature(secret: string, rawBody: Buffer | string, header?: string | null): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, header);
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

/** Case-insensitive single-value header read (Node lowercases incoming header names). */
export function header(headers: WebhookHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Authenticate a git webhook delivery against the per-app secret: accepted when ANY present scheme verifies.
 * Every scheme is keyed by the SAME secret, so accepting any one is not weaker than first-header-wins — and it
 * removes false 401s when Gitea sends a legacy sha1 `X-Hub-Signature` next to a valid `X-Gitea-Signature`.
 * Bitbucket (Cloud + Server) signs with `X-Hub-Signature: sha256=<hex>`, the same format as GitHub's
 * `X-Hub-Signature-256`. NOTE: GitLab's `X-Gitlab-Token` is a shared secret echoed back — it carries NO body
 * integrity. There is deliberately no unsigned acceptance path. All schemes are evaluated (no short-circuit).
 */
export function verifyWebhookRequest(secret: string, headers: WebhookHeaders, rawBody: Buffer | string): boolean {
  const ghSig256 = header(headers, "x-hub-signature-256");
  const ghSig = header(headers, "x-hub-signature"); // Bitbucket: sha256=<hex>; legacy GitHub/Gitea sha1= never verifies
  const glToken = header(headers, "x-gitlab-token");
  const giteaSig = header(headers, "x-gitea-signature") ?? header(headers, "x-forgejo-signature");
  const results = [
    ghSig256 != null && verifyGithubSignature(secret, rawBody, ghSig256),
    ghSig != null && verifyGithubSignature(secret, rawBody, ghSig),
    glToken != null && verifyGitlabToken(secret, glToken),
    giteaSig != null && verifyGiteaSignature(secret, rawBody, giteaSig),
  ];
  return results.some(Boolean);
}

/** Extract the git ref (e.g. "refs/heads/main") from a push payload. GitHub/GitLab/Gitea send
 *  `ref: "refs/heads/<branch>"`; Bitbucket sends `push.changes[].new.{type:"branch", name}` — normalize the
 *  latter to the same `refs/heads/<branch>` shape so refMatchesBranch works across providers. */
export function parseRef(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const ref = (payload as { ref?: unknown }).ref;
  if (typeof ref === "string") return ref;
  // Bitbucket push: first change whose `new` is a branch.
  const changes = (payload as { push?: { changes?: unknown } }).push?.changes;
  if (Array.isArray(changes)) {
    for (const c of changes) {
      const n = (c as { new?: { type?: unknown; name?: unknown } } | null)?.new;
      if (n && n.type === "branch" && typeof n.name === "string" && n.name) return `refs/heads/${n.name}`;
    }
  }
  return null;
}

/** True when the pushed ref targets the app's tracked branch. */
export function refMatchesBranch(ref: string | null, branch: string): boolean {
  if (!ref) return false;
  return ref === `refs/heads/${branch}`;
}

/**
 * Extract the head commit message from a push payload. GitHub uses
 * `head_commit.message`; GitLab sends `commits[]` (last entry is the head).
 */
export function parseHeadCommitMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    head_commit?: { message?: unknown };
    commits?: { message?: unknown }[];
  };
  const gh = p.head_commit?.message;
  if (typeof gh === "string") return gh;
  const list = Array.isArray(p.commits) ? p.commits : [];
  const last = list[list.length - 1]?.message;
  return typeof last === "string" ? last : null;
}

/**
 * True when the commit message carries a CI/CD skip marker (e.g. `[skip ci]`,
 * `[skip deploy]`) — standard convention for suppressing an auto-deploy.
 */
export function hasSkipMarker(message: string | null | undefined): boolean {
  if (!message) return false;
  return /\[(skip ci|ci skip|skip cd|cd skip|skip deploy|no deploy)\]/i.test(message);
}

/**
 * The `owner/repo` (lowercased) a git remote URL points at, or null — from an https, scheme or `git@`
 * form, with any `user@` prefix, `.git` suffix and trailing slash stripped. Used to match a webhook's
 * `repository.full_name` EXACTLY: a substring match would fire `acme/app` for a push to `acme/app-2`,
 * `acme/application`, or even `evil/acme/app`.
 */
export function repoFullName(gitUrl: string | null | undefined): string | null {
  if (!gitUrl) return null;
  let s = gitUrl.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  const ssh = s.match(/^[^/\s]+@[^:/]+:(.+)$/); // git@github.com:owner/repo
  if (ssh) {
    s = ssh[1];
  } else {
    const scheme = s.match(/^[a-z][a-z0-9+.-]*:\/\/(.+)$/); // https://[user@]host/owner/repo
    if (scheme) {
      const rest = scheme[1].replace(/^[^/@]*@/, ""); // drop a user@ (e.g. x-access-token@)
      const slash = rest.indexOf("/");
      if (slash < 0) return null;
      s = rest.slice(slash + 1); // drop the host
    }
  }
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export function generateWebhookToken(): string {
  return `tugra_wh_${randomBytes(24).toString("base64url")}`;
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

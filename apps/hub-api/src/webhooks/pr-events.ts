/**
 * Pure (I/O-free) normaliser for pull / merge request webhook events from GitHub, GitLab, Gitea / Forgejo and
 * Bitbucket (Cloud + Server / Data Center). Every provider's payload is mapped onto ONE internal shape so the
 * service has a single fail-closed gate in front of upsertPreview / removePreviewByPr.
 *
 * Field names below were checked against each provider's published docs / schema (GitLab "Merge request events",
 * Gitea `modules/structs` PullRequestPayload + deliver headers, Forgejo webhook docs, Bitbucket Cloud
 * `pullrequest:*` payloads + "Manage webhooks", Bitbucket Server `pr:*` event payloads). Every reader is total:
 * a wrong type yields null / "ignore", never a throw, and a string-typed number is rejected, not coerced.
 */
import { header } from "./webhook-verify";

export type PrProvider = "github" | "gitlab" | "gitea" | "forgejo" | "bitbucket" | "bitbucket-server";
/** "other" = the existing handlePush path, byte-identical. */
export type GitEventKind = "pr" | "ignore" | "other";

export interface DetectedEvent {
  provider: PrProvider | null;
  kind: GitEventKind;
  name: string | null;
}

export interface NormalizedPr {
  provider: PrProvider;
  action: "upsert" | "upsert-if-head-changed" | "close" | "ignore";
  /** The provider's own action / event key — only used for the response `reason`. */
  rawAction: string;
  /** Set when an `ignore` has a more specific user-facing reason than "<provider> <rawAction> (ignored)". */
  ignoreReason?: string;
  /** GitLab iid, Bitbucket pullrequest.id / pullRequest.id, GitHub / Gitea number. */
  prNumber: number;
  /** Source branch; required for upsert actions. */
  headRef: string | null;
  /** Lowercase hex 7..64, else null. */
  headSha: string | null;
  /** Lowercase "owner/repo" (last two path segments, same rule as repoFullName()). */
  baseRepo: string | null;
  /** The head repo is KNOWN and equal to the base repo. Unknown => false (fail closed). */
  sameRepo: boolean;
}

type Headers = Record<string, string | string[] | undefined>;

/**
 * Which provider sent this delivery and whether it is a PR/MR event. First match wins; the ORDER matters:
 * Gitea and Forgejo also send GitHub-compat headers (X-GitHub-Event), so their own headers are checked first or
 * they would be parsed with the GitHub mapping. Header detection is NOT a trust boundary — it runs only after the
 * request was authenticated and merely selects a parser; every field is validated afterwards.
 */
export function detectGitEvent(headers: Headers): DetectedEvent {
  const forgejo = header(headers, "x-forgejo-event");
  const gitea = header(headers, "x-gitea-event");
  if (forgejo != null || gitea != null) {
    const provider: PrProvider = forgejo != null ? "forgejo" : "gitea";
    const name = (forgejo ?? gitea) as string;
    if (name === "pull_request" || name === "pull_request_sync") return { provider, kind: "pr", name };
    // review / comment / label / assign / milestone … siblings must not fall into handlePush.
    if (name.startsWith("pull_request_")) return { provider, kind: "ignore", name };
    return { provider, kind: "other", name };
  }
  const gitlab = header(headers, "x-gitlab-event");
  if (gitlab != null) {
    return { provider: "gitlab", kind: gitlab === "Merge Request Hook" ? "pr" : "other", name: gitlab };
  }
  const key = header(headers, "x-event-key");
  if (key != null) {
    if (key.startsWith("pullrequest:")) return { provider: "bitbucket", kind: "pr", name: key };
    if (key.startsWith("pr:")) return { provider: "bitbucket-server", kind: "pr", name: key };
    return { provider: null, kind: "other", name: key };
  }
  const gh = header(headers, "x-github-event");
  if (gh === "pull_request") return { provider: "github", kind: "pr", name: gh };
  return { provider: null, kind: "other", name: gh ?? null };
}

/** A PR number: a positive 32-bit integer (Prisma Int; also interpolated into the `pr<n>.<apex>` hostname). */
export function isValidPrNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= 2147483647;
}

/** The house BRANCH rule (applications/dto.ts) plus: no trailing `/` and no `.lock` suffix. */
export function isSafePreviewBranch(ref: string): boolean {
  if (typeof ref !== "string" || ref.length < 1 || ref.length > 255) return false;
  if (!/^[A-Za-z0-9._#/-]+$/.test(ref)) return false;
  if (ref.includes("..") || ref.startsWith("-")) return false;
  if (ref.endsWith("/") || ref.endsWith(".lock")) return false;
  return true;
}

// ── total readers ──

type Obj = Record<string, unknown>;
function obj(v: unknown): Obj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function at(v: unknown, ...path: string[]): unknown {
  let cur: unknown = v;
  for (const k of path) {
    const o = obj(cur);
    if (!o) return undefined;
    cur = o[k];
  }
  return cur;
}
function sha(v: unknown): string | null {
  return typeof v === "string" && /^[0-9a-fA-F]{7,64}$/.test(v) ? v.toLowerCase() : null;
}
/** Lowercased last two path segments of "owner/repo" or "group/sub/repo" (matches repoFullName()). */
function lastTwo(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const parts = path.toLowerCase().split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}
function sameStr(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.length > 0 && a.toLowerCase() === b.toLowerCase();
}
/** Numeric ids: when BOTH are numbers they must be equal; absence of either is not a mismatch. */
function idsConflict(a: unknown, b: unknown): boolean {
  return typeof a === "number" && typeof b === "number" && a !== b;
}

type Action = NormalizedPr["action"];

function build(
  provider: PrProvider,
  action: Action,
  rawAction: string,
  prNumber: unknown,
  headRef: unknown,
  headSha: unknown,
  baseRepo: string | null,
  sameRepo: boolean,
  ignoreReason?: string,
): NormalizedPr | null {
  if (!isValidPrNumber(prNumber)) return null;
  const ref = str(headRef);
  // An upsert without a source branch is unusable; close / ignore never need it.
  if ((action === "upsert" || action === "upsert-if-head-changed") && !ref) return null;
  return {
    provider,
    action,
    rawAction,
    ...(ignoreReason ? { ignoreReason } : {}),
    prNumber,
    headRef: ref,
    headSha: sha(headSha),
    baseRepo,
    sameRepo,
  };
}

function normGithub(p: unknown): NormalizedPr | null {
  const rawAction = str(at(p, "action"));
  if (!rawAction) return null;
  const pr = at(p, "pull_request");
  const action: Action =
    rawAction === "opened" || rawAction === "reopened" || rawAction === "synchronize"
      ? "upsert"
      : rawAction === "closed"
        ? "close"
        : "ignore";
  const headFull = at(pr, "head", "repo", "full_name");
  const baseFull = at(pr, "base", "repo", "full_name");
  return build(
    "github",
    action,
    rawAction,
    at(pr, "number"),
    at(pr, "head", "ref"),
    at(pr, "head", "sha"),
    lastTwo(baseFull),
    sameStr(headFull, baseFull),
  );
}

function normGitea(provider: "gitea" | "forgejo", p: unknown): NormalizedPr | null {
  const rawAction = str(at(p, "action"));
  if (!rawAction) return null;
  const pr = at(p, "pull_request");
  const inner = at(pr, "number");
  const outer = at(p, "number");
  if (inner !== undefined && outer !== undefined && inner !== outer) return null;
  const num = inner !== undefined ? inner : outer;
  const action: Action =
    rawAction === "opened" || rawAction === "reopened" || rawAction === "synchronized" || rawAction === "synchronize"
      ? "upsert"
      : rawAction === "closed"
        ? "close"
        : "ignore";
  const headFull = at(pr, "head", "repo", "full_name");
  const baseFull = at(pr, "base", "repo", "full_name");
  const same = sameStr(headFull, baseFull) && !idsConflict(at(pr, "head", "repo", "id"), at(pr, "base", "repo", "id"));
  return build(provider, action, rawAction, num, at(pr, "head", "ref"), at(pr, "head", "sha"), lastTwo(baseFull), same);
}

function normGitlab(p: unknown): NormalizedPr | null {
  if (at(p, "object_kind") !== "merge_request") return null;
  const oa = at(p, "object_attributes");
  const rawAction = str(at(oa, "action"));
  if (!rawAction) return null;
  let action: Action = "ignore";
  let ignoreReason: string | undefined;
  if (rawAction === "open" || rawAction === "reopen") action = "upsert";
  else if (rawAction === "update") {
    // `update` also fires for title / label / assignee edits; `oldrev` is only present when new commits landed.
    if (str(at(oa, "oldrev"))) action = "upsert";
    else ignoreReason = "MR update without new commits (ignored)";
  } else if (rawAction === "close" || rawAction === "merge") action = "close";
  const src = at(oa, "source_project_id");
  const tgt = at(oa, "target_project_id");
  const same = typeof src === "number" && typeof tgt === "number" && src === tgt;
  const base = lastTwo(at(oa, "target", "path_with_namespace")) ?? lastTwo(at(p, "project", "path_with_namespace"));
  return build(
    "gitlab",
    action,
    rawAction,
    at(oa, "iid"), // the per-project MR number (!n), NOT the global `id`
    at(oa, "source_branch"),
    at(oa, "last_commit", "id"),
    base,
    same,
    ignoreReason,
  );
}

function normBitbucketCloud(p: unknown, eventName: string | null | undefined): NormalizedPr | null {
  const key = str(eventName);
  if (!key || !key.startsWith("pullrequest:")) return null;
  const rawAction = key.slice("pullrequest:".length);
  const pr = at(p, "pullrequest");
  let action: Action = "ignore";
  if (rawAction === "created") action = "upsert";
  else if (rawAction === "updated") action = at(pr, "state") === "OPEN" ? "upsert-if-head-changed" : "ignore";
  else if (rawAction === "fulfilled" || rawAction === "rejected") action = "close";
  const srcFull = at(pr, "source", "repository", "full_name");
  const dstFull = at(pr, "destination", "repository", "full_name");
  const srcUuid = at(pr, "source", "repository", "uuid");
  const dstUuid = at(pr, "destination", "repository", "uuid");
  const same = sameStr(srcFull, dstFull) && !(typeof srcUuid === "string" && typeof dstUuid === "string" && srcUuid !== dstUuid);
  return build(
    "bitbucket",
    action,
    rawAction,
    at(pr, "id"),
    at(pr, "source", "branch", "name"),
    at(pr, "source", "commit", "hash"),
    lastTwo(dstFull),
    same,
  );
}

function normBitbucketServer(p: unknown, eventName: string | null | undefined): NormalizedPr | null {
  const key = str(eventName);
  if (!key || !key.startsWith("pr:")) return null;
  const rawAction = key.slice("pr:".length);
  const pr = at(p, "pullRequest");
  let action: Action = "ignore";
  if (rawAction === "opened" || rawAction === "from_ref_updated") action = "upsert";
  else if (rawAction === "merged" || rawAction === "declined" || rawAction === "deleted") action = "close";
  const projKey = at(pr, "toRef", "repository", "project", "key");
  const slug = at(pr, "toRef", "repository", "slug");
  const base = typeof projKey === "string" && typeof slug === "string" && projKey && slug ? `${projKey}/${slug}`.toLowerCase() : null;
  const fromId = at(pr, "fromRef", "repository", "id");
  const toId = at(pr, "toRef", "repository", "id");
  const same = typeof fromId === "number" && typeof toId === "number" && fromId === toId;
  return build(
    "bitbucket-server",
    action,
    rawAction,
    at(pr, "id"),
    at(pr, "fromRef", "displayId"),
    at(pr, "fromRef", "latestCommit"),
    base,
    same,
  );
}

/**
 * Map one provider's PR / MR payload onto the internal shape. `eventName` is the event key (Bitbucket derives the
 * action from the `X-Event-Key` suffix, not the body). Null = not a usable PR event (ignored).
 */
export function normalizePullRequest(provider: PrProvider, payload: unknown, eventName?: string | null): NormalizedPr | null {
  if (!obj(payload)) return null;
  switch (provider) {
    case "github":
      return normGithub(payload);
    case "gitea":
    case "forgejo":
      return normGitea(provider, payload);
    case "gitlab":
      return normGitlab(payload);
    case "bitbucket":
      return normBitbucketCloud(payload, eventName);
    case "bitbucket-server":
      return normBitbucketServer(payload, eventName);
    default:
      return null;
  }
}

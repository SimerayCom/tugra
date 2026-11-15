// Custom pushed image name + mutable alias tag (pure, no Nest). The IMMUTABLE ref
// (`<registry>/<name>:<deploymentId>`) is always pushed; the alias is an optional extra, registry-side only.
// FAIL CLOSED: a name or tag that fails validation is never interpolated into a script, and everything is
// re-checked at deploy time even though the DTO already checked it.

export const PUSH_NAME_MAX = 128;

const COMPONENT = "[a-z0-9]+(?:(?:\\.|_|__|-+)[a-z0-9]+)*";
/** 1..4 lower-case path components joined by "/" (docker repository-name grammar). */
export const PUSH_NAME_RE = new RegExp(`^${COMPONENT}(?:/${COMPONENT}){0,3}$`);
/** A real docker tag. */
export const PUSH_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
/** An alias TEMPLATE: tag characters plus the two tokens. */
export const PUSH_TAG_TPL_RE = /^(?:[A-Za-z0-9_.-]|\{(?:sha|branch)\})+$/;
/** The shape of a Deployment id (cuid): an alias that looks like one could shadow an immutable tag. */
export const CUID_SHAPE_RE = /^c[a-z0-9]{24}$/;

export const PUSH_TAG_TPL_MAX = 160;

const SHA_SAMPLE = "0123456789ab"; // worst-case {sha}: 12 hex
const BRANCH_SAMPLE = "a".repeat(64); // worst-case {branch}: sanitized + cut to 64

export type PushNameError = "empty" | "too_long" | "bad_name" | "reserved";

/** null = ok, else a reason code. The `tugra_` prefix is reserved for default repos so a custom name can
 *  never target another app's default repo. */
export function validatePushName(name: string): PushNameError | null {
  if (!name) return "empty";
  if (name.length > PUSH_NAME_MAX) return "too_long";
  if (!PUSH_NAME_RE.test(name)) return "bad_name";
  if (name.split("/")[0].startsWith("tugra_")) return "reserved";
  return null;
}

/** `[^A-Za-z0-9_.-]` -> "-", strip leading `.`/`-`, cut to 64. May return "". */
export function sanitizeBranchForTag(branch: string): string {
  return branch.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[.-]+/, "").slice(0, 64);
}

export type TagTemplateError = "invalid_char" | "needs_git" | "bad_tag" | "reserved" | "compose";

export function validateTagTemplate(tpl: string, source: "GIT" | "IMAGE" | "COMPOSE"): TagTemplateError | null {
  if (source === "COMPOSE") return "compose";
  if (!tpl || tpl.length > PUSH_TAG_TPL_MAX || !PUSH_TAG_TPL_RE.test(tpl)) return "invalid_char";
  const hasSha = tpl.includes("{sha}");
  const hasBranch = tpl.includes("{branch}");
  if ((hasSha || hasBranch) && source !== "GIT") return "needs_git";
  const sample = tpl.replaceAll("{sha}", SHA_SAMPLE).replaceAll("{branch}", BRANCH_SAMPLE);
  if (!PUSH_TAG_RE.test(sample)) return "bad_tag";
  // Any {sha} substitution is lower-case hex, so it is shape-equivalent to the sample; only {branch} is unknowable here
  // (resolveAlias re-checks it with the real branch).
  if (!hasBranch && CUID_SHAPE_RE.test(sample)) return "reserved";
  return null;
}

/** The template split on "{sha}": parts.length > 1 means the sha token is used (join with the 12-hex commit). */
export interface PushAlias {
  parts: string[];
}

export function resolveAlias(
  tpl: string,
  ctx: { branch: string; source: "GIT" | "IMAGE" },
  depId: string,
): PushAlias {
  const bad = validateTagTemplate(tpl, ctx.source);
  if (bad) throw new Error(`TUGRA: alias tag is not valid (${bad})`);
  const withBranch = tpl.replaceAll("{branch}", sanitizeBranchForTag(ctx.branch));
  const parts = withBranch.split("{sha}");
  const sample = parts.join(SHA_SAMPLE);
  if (!sample || !PUSH_TAG_RE.test(sample)) throw new Error("TUGRA: alias tag resolves to an empty or invalid tag");
  if (CUID_SHAPE_RE.test(sample)) throw new Error("TUGRA: alias tag resolves to a reserved (deployment-id shaped) tag");
  if (parts.length === 1 && parts[0] === depId) throw new Error("TUGRA: alias tag equals the immutable tag");
  return { parts };
}

/** pushTag minus its trailing ":<version>". */
export function registryRepoOf(pushTag: string): string {
  const i = pushTag.lastIndexOf(":");
  return i > pushTag.lastIndexOf("/") ? pushTag.slice(0, i) : pushTag;
}

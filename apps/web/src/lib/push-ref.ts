// Custom pushed image name + alias tag: client-side mirror of the hub's `deploy/push-ref.ts` (the web does not import
// the hub or @tugra/shared). The hub re-validates everything; this only gives instant feedback and a live preview.
// Keep the test vectors in push-ref.test.ts identical to the hub spec.

export const PUSH_NAME_MAX = 128;
export const PUSH_TAG_TPL_MAX = 160;

const COMPONENT = "[a-z0-9]+(?:(?:\\.|_|__|-+)[a-z0-9]+)*";
/** 1..4 lower-case path components joined by "/". */
export const PUSH_NAME_RE = new RegExp(`^${COMPONENT}(?:/${COMPONENT}){0,3}$`);
export const PUSH_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
export const PUSH_TAG_TPL_RE = /^(?:[A-Za-z0-9_.-]|\{(?:sha|branch)\})+$/;
/** The shape of a deployment id: an alias that looks like one could shadow an immutable tag. */
export const CUID_SHAPE_RE = /^c[a-z0-9]{24}$/;

const SHA_SAMPLE = "0123456789ab";
const BRANCH_SAMPLE = "a".repeat(64);

export type PushNameError = "empty" | "too_long" | "bad_name" | "reserved";
export type TagTemplateError = "invalid_char" | "needs_git" | "bad_tag" | "reserved" | "compose";

/** null = ok. The `tugra_` prefix is reserved for default repos. */
export function validatePushName(name: string): PushNameError | null {
  if (!name) return "empty";
  if (name.length > PUSH_NAME_MAX) return "too_long";
  if (!PUSH_NAME_RE.test(name)) return "bad_name";
  if (name.split("/")[0].startsWith("tugra_")) return "reserved";
  return null;
}

export function sanitizeBranchForTag(branch: string): string {
  return branch.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[.-]+/, "").slice(0, 64);
}

export function validateTagTemplate(tpl: string, source: "GIT" | "IMAGE" | "COMPOSE"): TagTemplateError | null {
  if (source === "COMPOSE") return "compose";
  if (!tpl || tpl.length > PUSH_TAG_TPL_MAX || !PUSH_TAG_TPL_RE.test(tpl)) return "invalid_char";
  const hasSha = tpl.includes("{sha}");
  const hasBranch = tpl.includes("{branch}");
  if ((hasSha || hasBranch) && source !== "GIT") return "needs_git";
  const sample = tpl.replaceAll("{sha}", SHA_SAMPLE).replaceAll("{branch}", BRANCH_SAMPLE);
  if (!PUSH_TAG_RE.test(sample)) return "bad_tag";
  if (!hasBranch && CUID_SHAPE_RE.test(sample)) return "reserved";
  return null;
}

/** The registry reference the built image is pushed to: `[<host>/]<ns>/<name || tugra_<id>>:<version>`
 *  (equal to the hub's registryImageRef). */
export function registryRefPreview(
  reg: { url?: string | null; imagePrefix?: string | null; username?: string | null },
  appId: string,
  name: string | null,
  version: string,
): string {
  const trim = (s: string) => s.replace(/\/+$/, "");
  const host = reg.url ? `${trim(reg.url)}/` : "";
  const ns = reg.imagePrefix ? trim(reg.imagePrefix) : trim(reg.username ?? "");
  const prefix = ns ? `${ns}/` : "";
  return `${host}${prefix}${name || `tugra_${appId}`}:${version}`;
}

/** An example alias ref for the preview: the template with {branch}/{sha} filled with sample values. */
export function aliasRefPreview(
  reg: { url?: string | null; imagePrefix?: string | null; username?: string | null },
  appId: string,
  name: string | null,
  tpl: string,
  ctx: { branch: string },
): string {
  const tag = tpl.replaceAll("{branch}", sanitizeBranchForTag(ctx.branch || "main")).replaceAll("{sha}", SHA_SAMPLE);
  return registryRefPreview(reg, appId, name, tag);
}

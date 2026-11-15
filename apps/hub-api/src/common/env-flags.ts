/**
 * Per-variable env flags (buildTime / runtime / literal / multiline). PURE: no Prisma, Nest or deploy imports so
 * both `applications/*` and `deploy/*` can use it without a cycle.
 *
 * Internal form is SPARSE - only non-default flags are stored: `{ buildTime?: true; runtime?: false; literal?: true;
 * multiline?: true }`. Defaults: buildTime off, runtime on, literal off, multiline off. An empty meta means "no flags
 * anywhere", which must behave byte-identically to an app that never had the feature.
 */
import { ENV_KEY_DENY, ML_VALUE_MAX_BYTES, isHostExportSafeKey } from "./env-key";

export { ML_VALUE_MAX_BYTES };

export interface EnvFlags {
  buildTime?: true;
  runtime?: false;
  literal?: true;
  multiline?: true;
}
/** ALWAYS built with Object.create(null) and sorted keys. */
export type EnvMeta = Record<string, EnvFlags>;

export const ENV_META_V = 1;
export const ML_KEYS_MAX = 32;
export const ML_TOTAL_MAX_BYTES = 48 * 1024;
/** Equal to BUILD_SECRETS_MAX_TOTAL_BYTES (applications/dto.ts); duplicated here to keep this module import-free. */
export const BUILD_FLAG_TOTAL_MAX_BYTES = 48 * 1024;
/** Same pattern as BUILD_ARG_KEY in deploy/build-args.ts (kept local: build-args imports applications/dto which imports this). */
const BUILD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type FlagInput = Partial<{ buildTime: boolean; runtime: boolean; literal: boolean; multiline: boolean }>;

const FLAG_NAMES = ["buildTime", "runtime", "literal", "multiline"] as const;

function emptyMeta(): EnvMeta {
  return Object.create(null) as EnvMeta;
}

function has(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function sparse(f: unknown): EnvFlags | null {
  if (!f || typeof f !== "object" || Array.isArray(f)) return null;
  const o = f as Record<string, unknown>;
  const out: EnvFlags = {};
  if (has(o, "buildTime") && o.buildTime === true) out.buildTime = true;
  if (has(o, "runtime") && o.runtime === false) out.runtime = false;
  if (has(o, "literal") && o.literal === true) out.literal = true;
  if (has(o, "multiline") && o.multiline === true) out.multiline = true;
  return Object.keys(out).length ? out : null;
}

function sortedMeta(entries: [string, EnvFlags][]): EnvMeta {
  const m = emptyMeta();
  for (const [k, v] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) m[k] = v;
  return m;
}

/** Keeps only buildTime===true, runtime===false, literal===true, multiline===true; drops empty entries and keys not in envKeys. */
export function normalizeFlags(raw: unknown, envKeys: Iterable<string>): EnvMeta {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyMeta();
  const keys = new Set(envKeys);
  const out: [string, EnvFlags][] = [];
  for (const k of Object.keys(raw)) {
    if (ENV_KEY_DENY.has(k) || !keys.has(k)) continue;
    const f = sparse((raw as Record<string, unknown>)[k]);
    if (f) out.push([k, f]);
  }
  return sortedMeta(out);
}

/** "" | joined with "+" in fixed order: build|build-only, literal, multiline. */
export function flagsToken(f?: EnvFlags): string {
  if (!f) return "";
  const parts: string[] = [];
  if (f.buildTime) parts.push(f.runtime === false ? "build-only" : "build");
  if (f.literal) parts.push("literal");
  if (f.multiline) parts.push("multiline");
  // runtime:false without buildTime is invalid but must still be visible in a diff
  if (f.runtime === false && !f.buildTime) parts.unshift("runtime-off");
  return parts.join("+");
}

export function pruneMeta(meta: EnvMeta, keys: Iterable<string>): EnvMeta {
  const keep = new Set(keys);
  return sortedMeta(Object.keys(meta).filter((k) => keep.has(k)).map((k) => [k, meta[k]] as [string, EnvFlags]));
}

export class EnvMetaCorruptError extends Error {
  constructor(message = "TUGRA: env flags unreadable") {
    super(message);
    this.name = "EnvMetaCorruptError";
  }
}

/** Throws EnvMetaCorruptError on bad JSON, unknown version, non-object flags, unknown flag names or value types. DB content is never trusted. */
export function parseEnvMeta(plain: string | null): EnvMeta {
  if (plain === null || plain === undefined) return emptyMeta();
  let j: unknown;
  try {
    j = JSON.parse(plain);
  } catch {
    throw new EnvMetaCorruptError();
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new EnvMetaCorruptError();
  const o = j as Record<string, unknown>;
  if (o.v !== ENV_META_V) throw new EnvMetaCorruptError();
  const flags = o.flags;
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) throw new EnvMetaCorruptError();
  const out: [string, EnvFlags][] = [];
  for (const k of Object.keys(flags)) {
    if (ENV_KEY_DENY.has(k)) throw new EnvMetaCorruptError();
    const e = (flags as Record<string, unknown>)[k];
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new EnvMetaCorruptError();
    for (const [fk, fv] of Object.entries(e as Record<string, unknown>)) {
      if (!(FLAG_NAMES as readonly string[]).includes(fk)) throw new EnvMetaCorruptError();
      if (fk === "runtime" ? fv !== false : fv !== true) throw new EnvMetaCorruptError();
    }
    const f = sparse(e);
    if (f) out.push([k, f]);
  }
  return sortedMeta(out);
}

/** null when empty so the column returns to NULL. */
export function encodeEnvMeta(meta: EnvMeta): string | null {
  const keys = Object.keys(meta);
  if (keys.length === 0) return null;
  const flags: Record<string, EnvFlags> = {};
  for (const k of [...keys].sort()) flags[k] = meta[k];
  return JSON.stringify({ v: ENV_META_V, flags });
}

export interface FlagIssue {
  key: string;
  code: string;
  message: string;
}
export interface FlagCtx {
  /** undefined = context-free (zod stage): ctx-dependent rules skipped. */
  source?: "IMAGE" | "GIT" | "COMPOSE";
  buildSecretKeys?: ReadonlySet<string>;
  mode?: "write" | "deploy";
}

/** The legacy message; existing clients/tests match it verbatim. */
export const NEWLINE_MESSAGE = "environment value must not contain a newline";

function b(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** ONE validator for zod superRefine, the service and deploy. Deterministic order (sorted keys). */
export function validateEnvFlags(env: Record<string, string>, meta: EnvMeta, ctx: FlagCtx): FlagIssue[] {
  const mode = ctx.mode ?? "write";
  const issues: FlagIssue[] = [];
  const add = (key: string, code: string, message: string) => issues.push({ key, code, message });
  const envKeys = Object.keys(env).sort();
  const metaKeys = Object.keys(meta).sort();

  if (mode === "write") {
    for (const k of metaKeys) if (!has(env, k)) add(k, "FLAG_KEY_MISSING", `variable ${k} has flags but is not in the environment`);
  }

  for (const k of envKeys) {
    const v = env[k];
    if (v.includes("\u0000")) add(k, "VALUE_NUL", `variable ${k}: environment value must not contain a NUL character`);
    else if (/[\r\n]/.test(v) && !meta[k]?.multiline) add(k, "VALUE_NEWLINE", NEWLINE_MESSAGE);
  }

  let mlCount = 0;
  let mlBytes = 0;
  let buildBytes = 0;
  for (const k of metaKeys) {
    const f = meta[k];
    if (!has(env, k)) continue;
    const v = env[k];
    if (f.multiline) {
      mlCount++;
      mlBytes += b(v);
      if (!isHostExportSafeKey(k)) add(k, "ML_KEY", `variable ${k}: a multiline variable name must use letters, digits and underscores and cannot be a reserved name`);
      if (b(v) > ML_VALUE_MAX_BYTES) add(k, "ML_SIZE", `variable ${k}: a multiline value can be at most ${ML_VALUE_MAX_BYTES / 1024} KiB`);
    }
    if (f.literal && ctx.source === "COMPOSE" && !isHostExportSafeKey(k)) {
      add(k, "LITERAL_KEY", `variable ${k}: a literal variable name must use letters, digits and underscores and cannot be a reserved name`);
    }
    if (ctx.source !== undefined && ctx.source !== "GIT") {
      if (f.runtime === false) add(k, "BUILD_SOURCE", `variable ${k} is build-only but this app has no build step`);
      else if (f.buildTime && mode === "write") add(k, "BUILD_SOURCE", `variable ${k}: build-time variables apply to Git-built apps only`);
    }
    if (f.buildTime) {
      if (!BUILD_KEY_RE.test(k)) add(k, "BUILD_KEY", `variable ${k}: a build-time variable name must use letters, digits and underscores`);
      buildBytes += b(`${k}=${v}`);
    }
    if (f.runtime === false && !f.buildTime) add(k, "RUNTIME_OFF_NEEDS_BUILD", `variable ${k}: a variable that is off at runtime must be available at build time`);
  }
  if (mlCount > ML_KEYS_MAX) add("", "ML_SIZE", `at most ${ML_KEYS_MAX} multiline variables`);
  if (mlBytes > ML_TOTAL_MAX_BYTES) add("", "ML_SIZE", `multiline values total at most ${ML_TOTAL_MAX_BYTES / 1024} KiB`);
  if (buildBytes > BUILD_FLAG_TOTAL_MAX_BYTES) add("", "BUILD_SIZE", `build-time variables total at most ${BUILD_FLAG_TOTAL_MAX_BYTES / 1024} KiB`);
  return issues;
}

/**
 * Render-time upgrade for values stored BEFORE the Multiline flag existed (shared variables, linked-DB and secret
 * values and app env all reach the env file as plain lines). Such a value that holds a line break and is not flagged
 * is delivered as a multiline variable instead of failing every deploy and rollback, provided its name passes the
 * host-export policy and it fits the multiline limits. Nothing is persisted: the returned meta is for rendering only.
 * `issue` is set (naming the key) for the first value that cannot ride that transport. Build-only keys never reach the
 * runtime, so they are left alone.
 */
export function autoMultilineLegacy(merged: Record<string, string>, meta: EnvMeta): { meta: EnvMeta; keys: string[]; issue: FlagIssue | null } {
  const keys: string[] = [];
  const next: [string, EnvFlags][] = Object.keys(meta).map((k) => [k, meta[k]]);
  for (const k of Object.keys(merged).sort()) {
    const v = merged[k];
    if (!/[\r\n]/.test(v) || meta[k]?.multiline || meta[k]?.runtime === false) continue;
    if (v.includes("\u0000") || b(v) > ML_VALUE_MAX_BYTES || !isHostExportSafeKey(k)) {
      return {
        meta,
        keys: [],
        issue: {
          key: k,
          code: "VALUE_NEWLINE",
          message: `TUGRA: environment variable ${JSON.stringify(k.slice(0, 40))} contains a line break and cannot be delivered as a multiline variable (reserved name, NUL or over ${ML_VALUE_MAX_BYTES / 1024} KiB); rename it or remove the line break`,
        },
      };
    }
    keys.push(k);
    const i = next.findIndex(([nk]) => nk === k);
    if (i >= 0) next[i] = [k, { ...next[i][1], multiline: true }];
    else next.push([k, { multiline: true }]);
  }
  return keys.length === 0 ? { meta, keys, issue: null } : { meta: sortedMeta(next), keys, issue: null };
}

export interface ApplyEnvFlagsInput {
  merged: Record<string, string>;
  appEnv: Record<string, string>;
  meta: EnvMeta;
  secretRefKeys: ReadonlySet<string>;
  buildSecretKeys: ReadonlySet<string>;
  builds: boolean;
}

/**
 * Applies the flags ONCE, right after the env merge. Build values come ONLY from the app's own env (never shared
 * variables, db-link URIs or Vault refs); a Vault-ref key may not carry buildTime / runtime:false (loud, not silent).
 */
export function applyEnvFlags(i: ApplyEnvFlagsInput): { env: Record<string, string>; buildArgs: Record<string, string>; buildFlagKeys: string[]; droppedForBuildSecret: string[] } {
  const keys = Object.keys(i.meta).sort();
  for (const k of keys) {
    const f = i.meta[k];
    if ((f.buildTime || f.runtime === false) && i.secretRefKeys.has(k)) {
      throw new Error(`TUGRA: variable ${k} comes from a secret reference and cannot be build-time or build-only`);
    }
  }
  const env: Record<string, string> = { ...i.merged };
  for (const k of keys) if (i.meta[k].runtime === false) delete env[k];
  const buildArgs: Record<string, string> = {};
  const dropped: string[] = [];
  if (i.builds) {
    for (const k of keys) {
      if (!i.meta[k].buildTime || !has(i.appEnv, k)) continue;
      if (i.buildSecretKeys.has(k)) dropped.push(k);
      else buildArgs[k] = i.appEnv[k];
    }
  }
  return { env, buildArgs, buildFlagKeys: Object.keys(buildArgs).sort(), droppedForBuildSecret: dropped };
}

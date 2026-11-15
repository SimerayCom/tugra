/**
 * Maps the per-variable flags a source carried (Coolify's build time / runtime / literal / multiline) onto Tugra's
 * `envFlags`, and auto-marks any value with a line break as Multiline. Pure; used by the importer and the migrator.
 *
 * Nothing silently disappears: a flag Tugra cannot carry for this app is DROPPED and reported by key name; a line
 * break on a name that cannot be a multiline variable FAILS the task loudly (it used to corrupt the env file).
 */
import { BUILD_KEY_RE, isHostExportSafeKey } from "../common/env-key";

export interface SourceEnvFlags {
  buildTime?: boolean;
  runtime?: boolean;
  literal?: boolean;
  multiline?: boolean;
}
export type EnvFlagsInput = Record<string, { buildTime?: boolean; runtime?: boolean; literal?: boolean; multiline?: boolean }>;

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Any value with CR/LF gets `multiline: true` when its name can carry it; otherwise throws (key name only). */
export function autoFlagMultiline(values: Record<string, string>, flags: EnvFlagsInput = {}): EnvFlagsInput {
  const out: EnvFlagsInput = {};
  for (const [k, f] of Object.entries(flags)) out[k] = { ...f };
  for (const k of Object.keys(values)) {
    if (!/[\r\n]/.test(values[k])) continue;
    if (!isHostExportSafeKey(k)) throw new Error(`env var ${JSON.stringify(k.slice(0, 40))} has a line break but its name cannot be a multiline variable`);
    out[k] = { ...(out[k] ?? {}), multiline: true };
  }
  return out;
}

/**
 * Source flags -> `envFlags` for create(), given the Tugra source the app maps to. Returns the flags to apply plus
 * human warnings (key names only) for every flag that was dropped.
 */
export function mapSourceEnvFlags(
  values: Record<string, string>,
  flags: Record<string, SourceEnvFlags> | undefined,
  source: "IMAGE" | "GIT" | "COMPOSE",
): { flags: EnvFlagsInput; warnings: string[] } {
  const out: EnvFlagsInput = {};
  const warnings: string[] = [];
  const drop = (k: string, flag: string, why: string) => warnings.push(`env var ${JSON.stringify(k.slice(0, 40))}: ${flag} flag not carried (${why})`);
  for (const k of Object.keys(flags ?? {}).sort()) {
    if (!own(values, k)) continue;
    const f = (flags as Record<string, SourceEnvFlags>)[k];
    const kept: { buildTime?: boolean; runtime?: boolean; literal?: boolean; multiline?: boolean } = {};
    if (f.buildTime === true) {
      if (source !== "GIT") drop(k, "build time", "only Git-built apps have a build step");
      else if (!BUILD_KEY_RE.test(k)) drop(k, "build time", "name is not a valid build argument name");
      else kept.buildTime = true;
    }
    if (f.runtime === false) {
      if (kept.buildTime) kept.runtime = false;
      else drop(k, "runtime off", "a variable that is off at runtime must also be a build-time variable on a Git-built app");
    }
    if (f.literal === true) {
      if (source === "COMPOSE" && !isHostExportSafeKey(k)) drop(k, "literal", "reserved or non-identifier name");
      else kept.literal = true;
    }
    if (f.multiline === true) {
      if (isHostExportSafeKey(k)) kept.multiline = true;
      else if (!/[\r\n]/.test(values[k])) drop(k, "multiline", "reserved or non-identifier name");
      // a value that really has a line break is handled (loudly) by autoFlagMultiline below
    }
    if (Object.keys(kept).length) out[k] = kept;
  }
  return { flags: autoFlagMultiline(values, out), warnings };
}

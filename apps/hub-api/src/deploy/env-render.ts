/**
 * Env placement planner. `docker run --env-file`, the swarm `read` loader and Compose's dotenv are three different
 * line-based (and, for Compose, interpolating) parsers, so a multiline - or Compose-literal - value cannot ride them.
 * Those values are base64-embedded in the hub-built deploy script, decoded into UNEXPORTED shell variables and attached
 * to exactly ONE command by scoped prefix assignment:
 *
 *   KEY="$TUGRA_ML_0" docker run ... -e KEY
 *
 * (`-e KEY` with no `=` copies the value from the docker CLI process environment: never argv, never the env file,
 * never exported to a later script step.) Swarm instead emits `KEY:b64=<base64>` lines that an in-container wrapper
 * decodes. Pure module: no deploy-script import, so deploy-script can import it without a cycle.
 */
import { ENV_KEY_RE, isHostExportSafeKey } from "../common/env-key";
import type { EnvMeta } from "../common/env-flags";

export type EnvTarget = "docker" | "compose" | "swarm";

export interface EnvPlan {
  /** Plain lines for the env-file / .env / swarm body. */
  fileEnv: Record<string, string>;
  /** docker + compose: delivered through the CLI process environment (sorted by key). */
  shell: { key: string; value: string }[];
  /** swarm: emitted as `KEY:b64=<base64>` lines inside the body. */
  b64Keys: ReadonlySet<string>;
}

/** Linux MAX_ARG_STRLEN is 131072; the script travels as ONE `bash -c` argument. */
export const SCRIPT_MAX_BYTES = 120 * 1024;

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

export function planEnv(env: Record<string, string>, meta: EnvMeta | undefined, target: EnvTarget): EnvPlan {
  const fileEnv: Record<string, string> = {};
  const shell: { key: string; value: string }[] = [];
  const b64 = new Set<string>();
  for (const k of Object.keys(env)) {
    const f = meta?.[k];
    if (f?.runtime === false) continue; // build-only; attach already removed it, this is defensive
    const v = env[k];
    if (v.includes("\u0000")) throw new Error(`TUGRA: env var ${JSON.stringify(k.slice(0, 40))} contains a NUL character`);
    if (/[\r\n]/.test(v) && !f?.multiline) {
      throw new Error(`TUGRA: env var ${JSON.stringify(k.slice(0, 40))} contains a line break but is not marked multiline`);
    }
    const viaShell = target === "docker" ? !!f?.multiline : target === "compose" ? !!(f?.multiline || f?.literal) : false;
    if ((f?.multiline || (f?.literal && target === "compose")) && !isHostExportSafeKey(k)) {
      throw new Error(`TUGRA: env var ${JSON.stringify(k.slice(0, 40))} cannot be a multiline or literal variable (reserved or non-identifier name)`);
    }
    if (viaShell) {
      shell.push({ key: k, value: v });
    } else {
      fileEnv[k] = v;
      if (target === "swarm" && f?.multiline) b64.add(k);
    }
  }
  shell.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { fileEnv, shell, b64Keys: b64 };
}

/** The decode lines (empty when there is nothing to deliver). `printf x` + `${v%x}` keeps trailing newlines (PEM). */
export function mlPrelude(shell: EnvPlan["shell"]): string[] {
  if (shell.length === 0) return [];
  const names = shell.map((s) => s.key).join(", ");
  return [
    `echo ${shq(`TUGRA_ENV_ML: ${shell.length} multiline variable(s) via the docker CLI environment (never argv, never the env file): ${names}`)}`,
    ...shell.map((s, i) => `TUGRA_ML_${i}=$(printf %s ${shq(Buffer.from(s.value, "utf8").toString("base64"))} | base64 -d; printf x); TUGRA_ML_${i}=\${TUGRA_ML_${i}%x}`),
  ];
}

function assertBareKeys(shell: EnvPlan["shell"]): void {
  for (const s of shell) if (!ENV_KEY_RE.test(s.key)) throw new Error(`TUGRA: env var ${JSON.stringify(s.key.slice(0, 40))} cannot be passed by name`);
}

/** `A="$TUGRA_ML_0" B="$TUGRA_ML_1" ` (trailing space) or ''. Scoped to the one command that follows. */
export function mlPrefix(shell: EnvPlan["shell"]): string {
  if (shell.length === 0) return "";
  assertBareKeys(shell);
  return shell.map((s, i) => `${s.key}="$TUGRA_ML_${i}"`).join(" ") + " ";
}

/** `-e A -e B` or ''. */
export function mlEnvFlags(shell: EnvPlan["shell"]): string {
  if (shell.length === 0) return "";
  assertBareKeys(shell);
  return shell.map((s) => `-e ${s.key}`).join(" ");
}

export function assertScriptFits(script: string): void {
  const n = Buffer.byteLength(script, "utf8");
  if (n > SCRIPT_MAX_BYTES) {
    throw new Error(`TUGRA: deploy script is ${n} bytes; limit ${SCRIPT_MAX_BYTES} (the script travels as one bash -c argument)`);
  }
}

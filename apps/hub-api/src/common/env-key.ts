/**
 * Shared env-var-name policy. `ENV_KEY_RE` and the reserved deny set were duplicated in the MCP tools;
 * this is the single source. Link-injected keys get an EXTRA deny list (names that would hijack the
 * container's runtime or Tugra's own wiring) — applied ONLY to database links, deliberately NOT retrofit
 * onto user-supplied env in v1 (that could reject keys already in use by migrated apps).
 */

/** A POSIX-ish env var name: a letter/underscore, then word characters. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Env names are generous but not unbounded. */
export const ENV_KEY_MAX = 128;

/**
 * Names the regex admits but that poke at Object internals / read oddly in an env map. Rejected
 * explicitly as defence-in-depth (callers use own-property semantics, so this isn't a live pollution
 * vector, but an env var literally named `__proto__`/`constructor`/`prototype` is never legitimate).
 */
export const ENV_KEY_DENY = new Set(["__proto__", "constructor", "prototype"]);

/** Exact names a database link must never inject (would change how the container's process behaves). */
const LINK_DENY_EXACT = new Set(["PATH", "HOME", "SHELL", "PORT", "HOSTNAME", "IFS", "USER", "PWD"]);

/** Prefixes a database link must never inject (dynamic-linker hijacks + Tugra/Docker/Compose wiring). */
const LINK_DENY_PREFIX = ["LD_", "DYLD_", "COMPOSE_", "DOCKER_", "TUGRA_"];

/** A syntactically valid, non-reserved env var name within the length cap. */
export function isValidEnvKey(k: string): boolean {
  return k.length > 0 && k.length <= ENV_KEY_MAX && ENV_KEY_RE.test(k) && !ENV_KEY_DENY.has(k);
}

/**
 * The injection boundary for USER-supplied env (NOT the strict POSIX `ENV_KEY_RE`). The env file is
 * `KEY=VALUE` lines joined by "\n", so the only key chars that actually corrupt it are `=` (splits the
 * pair), any whitespace/control char (a newline injects a whole new var; others read as garbage) and NUL.
 * Everything else printable — dots, dashes, colons — is a legitimate container env key (`spring.profiles.active`,
 * `my-app.setting`) that migrated apps already use, so the strict POSIX regex must NOT be retrofit onto them.
 */
export function isValidUserEnvKey(k: string): boolean {
  return (
    k.length > 0 &&
    k.length <= ENV_KEY_MAX &&
    !/[\s=\u0000-\u001f\u007f]/.test(k) && // no whitespace (incl. newline), '=', control chars or NUL
    !ENV_KEY_DENY.has(k)
  );
}

/** A user-supplied env VALUE that can't inject a second `--env-file` line: no newline, carriage return or NUL. */
export function isSafeEnvValue(v: string): boolean {
  return !/[\n\r\u0000]/.test(v);
}

/** A name a database link is allowed to inject: valid, and not one that would hijack the runtime. */
export function isLinkEnvKeyAllowed(k: string): boolean {
  if (!isValidEnvKey(k)) return false;
  if (LINK_DENY_EXACT.has(k)) return false;
  return !LINK_DENY_PREFIX.some((p) => k.startsWith(p));
}

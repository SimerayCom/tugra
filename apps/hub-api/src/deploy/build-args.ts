/**
 * Pure helper for "inject env as build args" (Dockerfile builds): turns the app's runtime env into the
 * `--build-arg` set. Imported by deploy-script.ts (script emission) and the service (pre-flight), so an
 * oversize environment fails early, before any container swap.
 */
import { BUILD_KEY_RE } from "../common/env-key";
import { BUILD_SECRETS_MAX_TOTAL_BYTES } from "../applications/dto"; // 48 KiB; the script travels as one bash -c argument

export const BUILD_ARG_KEY = BUILD_KEY_RE;

export function looksSensitiveKey(key: string): boolean {
  return /(^|[_-])(secret|token|passw(or)?d|private[_-]?key|api[_-]?key|access[_-]?key|credential|auth[_-]?(key|token|secret))s?($|[_-])/i.test(key);
}

export function injectableBuildArgs(app: { env?: Record<string, string>; buildArgs?: Record<string, string>; buildSecrets?: Record<string, string> }): {
  args: Record<string, string>;
  keys: string[];
  sensitive: string[];
  skipped: number;
} {
  const secretKeys = new Set(Object.keys(app.buildSecrets ?? {})); // a secret must never become a build arg
  const out: Record<string, string> = {};
  let skipped = 0;
  for (const [k, v] of Object.entries(app.env ?? {})) {
    if (!BUILD_ARG_KEY.test(k) || secretKeys.has(k)) {
      skipped++;
      continue;
    }
    out[k] = v;
  }
  const args = { ...out, ...(app.buildArgs ?? {}) }; // explicit build args win
  const bytes = Object.entries(args).reduce((n, [k, v]) => n + Buffer.byteLength(`${k}=${v}`, "utf8"), 0);
  if (bytes > BUILD_SECRETS_MAX_TOTAL_BYTES) {
    throw new Error(`TUGRA: injectEnvAsBuildArgs would pass ${bytes} bytes of environment as build arguments (limit ${BUILD_SECRETS_MAX_TOTAL_BYTES}) - trim the environment or use build secrets`);
  }
  const keys = Object.keys(args);
  return { args, keys, sensitive: keys.filter(looksSensitiveKey), skipped };
}

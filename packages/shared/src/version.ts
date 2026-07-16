/**
 * Version — the single source of truth for the wire protocol AND the application release version.
 *
 * PROTOCOL_VERSION is a compile-time constant (bumped only on breaking agent↔hub protocol changes).
 * The app/build metadata (version, channel, commit, edition) is read from the environment at CALL time,
 * injected at build/deploy via Docker ARG/ENV (TUGRA_VERSION / TUGRA_CHANNEL / GIT_SHA / TUGRA_EDITION);
 * everything falls back to a dev value so a local/unbuilt run is well-defined.
 */

// @tugra/shared carries no @types/node (it is transpiled into both the node hub and the web bundle). The
// version helpers only ever run in the node hub, so a minimal module-scoped ambient typing of `process` is
// enough — it is not emitted globally and does not pull the node type surface into the shared package.
declare const process: { env: Record<string, string | undefined> };

import { normalizeEdition, type Edition } from "./editions";

/** Wire-protocol version — the agent (Go) mirrors this; keep them in sync. */
export const PROTOCOL_VERSION = 2;

/** The application release version, e.g. "0.1.0". "0.0.0-dev" when TUGRA_VERSION is unset. */
export function appVersion(): string {
  return process.env.TUGRA_VERSION || "0.0.0-dev";
}

/** Release channel: "stable" | "beta" | "edge" | "dev". Defaults to "dev". */
export function releaseChannel(): string {
  return process.env.TUGRA_CHANNEL || "dev";
}

/** Short git SHA baked at build time; "" when unknown. */
export function gitSha(): string {
  return process.env.GIT_SHA || "";
}

/** Product edition ("community" | "pro" | "cloud"), env-driven (TUGRA_EDITION, build/license-injected).
 *  An unknown value normalises to "community" so a misconfigured env never unlocks a higher tier. */
export function edition(): Edition {
  return normalizeEdition(process.env.TUGRA_EDITION);
}

/** The full version descriptor served by GET /version and embedded in GET /health. */
export function versionInfo(): {
  version: string;
  protocol: number;
  channel: string;
  commit: string;
  edition: string;
} {
  return {
    version: appVersion(),
    protocol: PROTOCOL_VERSION,
    channel: releaseChannel(),
    commit: gitSha(),
    edition: edition(),
  };
}

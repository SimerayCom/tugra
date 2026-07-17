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

// ── Semver comparison (used by the self-update version check) ──
// A tiny, dependency-free comparator. It only needs to decide "is the published `latest` strictly
// NEWER than the running build" so the hub never offers a downgrade. Anchored parse (trailing garbage
// → null), tolerant of a leading "v" and a `+build` suffix (SemVer precedence ignores build metadata).

export interface ParsedVersion {
  /** [major, minor, patch] */
  core: [number, number, number];
  /** dot-separated pre-release identifiers ("1.2.3-rc.1" → ["rc","1"]); [] for a release. */
  pre: string[];
}

/**
 * Parse "x.y.z", "vX.Y.Z", "x.y.z-pre.1", "x.y.z+build" into its core + pre-release. Returns null for
 * anything that isn't a clean, fully-anchored version — the caller treats null as "unknown" and, for the
 * update check, as "no update" (fail-safe: a malformed remote version can never be reported as newer).
 */
export function parseVersion(v: string): ParsedVersion | null {
  if (typeof v !== "string") return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/**
 * Compare two ALREADY-PARSED versions: -1 (a<b) | 0 (equal precedence) | 1 (a>b). Callers that start
 * from strings must reject nulls FIRST (see isNewer) — this never sees an unparseable input, so its 0
 * unambiguously means "equal precedence" (build metadata and pre-release identifier detail beyond
 * "any pre-release < its release" are intentionally not distinguished; channels are kept separate).
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  // Equal core: a release (no pre-release) outranks a pre-release of the same core (SemVer §11).
  const aRel = a.pre.length === 0;
  const bRel = b.pre.length === 0;
  if (aRel !== bRel) return aRel ? 1 : -1;
  return 0;
}

/**
 * True only when `candidate` is strictly newer than `current`. Either side failing to parse → false
 * (fail-safe: the hub must never treat an unknown/garbage version as an available update — this is the
 * downgrade guard the whole self-update chain rests on). "0.0.0-dev" (local) < any real release.
 */
export function isNewer(candidate: string, current: string): boolean {
  const c = parseVersion(candidate);
  const cur = parseVersion(current);
  if (!c || !cur) return false;
  return compareVersions(c, cur) === 1;
}

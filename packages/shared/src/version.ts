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

/** Lowest wire protocol the hub still accepts from an agent. Equals PROTOCOL_VERSION until a breaking
 *  change forces supporting a range; raising PROTOCOL_VERSION without raising this keeps older agents. */
export const MIN_PROTOCOL_VERSION = 2;

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
 * unambiguously means "equal precedence". Pre-release identifiers ARE compared per SemVer §11.4
 * (so 0.1.0-beta.2 < 0.1.0-beta.3); only build metadata (+suffix) is ignored.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  // Equal core: a release (no pre-release) outranks a pre-release of the same core (SemVer §11.3).
  const aRel = a.pre.length === 0;
  const bRel = b.pre.length === 0;
  if (aRel !== bRel) return aRel ? 1 : -1;
  if (aRel && bRel) return 0;
  // Both pre-releases of the same core: compare identifiers left-to-right (SemVer §11.4) so that, e.g.,
  // 0.1.0-beta.2 < 0.1.0-beta.3 and a beta tester is offered the next beta through the update check.
  const n = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const ai = a.pre[i];
    const bi = b.pre[i];
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      if (ai !== bi) return Number(ai) < Number(bi) ? -1 : 1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1; // numeric identifiers rank below alphanumeric ones
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  // All shared identifiers equal: the longer identifier set has higher precedence.
  if (a.pre.length !== b.pre.length) return a.pre.length < b.pre.length ? -1 : 1;
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

/**
 * True only when `latest` is a PATCH upgrade of `current` — same major AND minor, strictly newer, and
 * NEITHER side is a pre-release. This is the gate for AUTO-update: patch releases (bugfixes) may be applied
 * automatically, but a minor/major bump (potential behavior change) or any pre-release must NEVER auto-apply
 * (notify-only). Fail-safe: an unparseable version → false. Manual updates ignore this (explicit consent).
 */
export function isPatchUpgrade(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return false;
  if (l.pre.length > 0 || c.pre.length > 0) return false;
  return l.core[0] === c.core[0] && l.core[1] === c.core[1] && compareVersions(l, c) === 1;
}

// ── Agent compatibility gate ──

export type AgentCompatReason = "protocol_too_old" | "protocol_too_new" | "agent_too_old";

/**
 * Decide whether an agent may connect, from its wire protocol and (optionally) a minimum agent version.
 * Pure + dependency-free so it is unit-testable and shared by the enroll AND auth handshakes. The caller
 * applies policy on the result: reject *_too_old, but warn-and-ACCEPT protocol_too_new, so that rolling the
 * hub back (e.g. the failed-update recovery) can never lock out an agent that already self-updated.
 *
 * `minAgentVersion` is UNSET by default (the version gate is OFF): existing deployments, dev builds
 * ("0.0.0-dev") and the hub-bundled local agent are never rejected on version. An unparseable
 * minAgentVersion fails OPEN (ignored) so a misconfigured env can never brick a fleet. This is a
 * compatibility guard, not a security control — an agent can lie about its version; identity still rests
 * on ed25519 auth and signed commands.
 */
export function checkAgentCompat(input: {
  protocol: unknown;
  agentVersion?: unknown;
  minAgentVersion?: string | null;
}): { ok: true } | { ok: false; reason: AgentCompatReason; detail: string } {
  const p = input.protocol;
  if (typeof p !== "number" || !Number.isSafeInteger(p)) {
    return {
      ok: false,
      reason: "protocol_too_old",
      detail: `agent sent an invalid protocol version; this hub speaks protocol ${MIN_PROTOCOL_VERSION}`,
    };
  }
  if (p < MIN_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: "protocol_too_old",
      detail: `agent protocol ${p} is older than the minimum ${MIN_PROTOCOL_VERSION} this hub supports; update the agent`,
    };
  }
  if (p > PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: "protocol_too_new",
      detail: `agent protocol ${p} is newer than this hub's ${PROTOCOL_VERSION}; update the hub`,
    };
  }
  // Minimum agent version is an optional operator policy, enforced only when set to a PARSEABLE version.
  const min = typeof input.minAgentVersion === "string" ? input.minAgentVersion.trim() : "";
  if (min) {
    const parsedMin = parseVersion(min);
    if (parsedMin) {
      const av = typeof input.agentVersion === "string" ? input.agentVersion : "";
      const parsedAgent = av ? parseVersion(av) : null;
      if (!parsedAgent || compareVersions(parsedAgent, parsedMin) < 0) {
        // The agent version is attacker-controlled and unauthenticated here, and `detail` is both logged and
        // echoed back — bound and strip control chars so it can't bloat a log line or forge one with newlines.
        const shown = av.slice(0, 64).replace(/[^\x20-\x7e]/g, "?") || "(unknown)";
        return {
          ok: false,
          reason: "agent_too_old",
          detail: `agent version ${shown} is below the minimum ${min} required by this hub; update the agent`,
        };
      }
    }
  }
  return { ok: true };
}

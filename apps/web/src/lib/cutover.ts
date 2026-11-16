import type { CutoverEntryView, CutoverView } from "./api";

// Pure view helpers for the SSL/DNS cutover panel. Every user-facing code (state, DNS, certificate, block reason,
// warning) is addressed through a LITERAL i18n key so the static key-coverage test can see it.

type T = (key: string, vars?: Record<string, string | number>) => string;

export type BadgeTone = "muted" | "gold" | "lapis" | "danger" | "warn" | "ok";

export const STATE_KEY: Record<string, string> = {
  PLANNED: "cutover.state.planned",
  CERT_PENDING: "cutover.state.certPending",
  CERT_READY: "cutover.state.certReady",
  READY: "cutover.state.ready",
  SWITCHING: "cutover.state.switching",
  SWITCHED: "cutover.state.switched",
  VERIFIED: "cutover.state.verified",
  VERIFY_FAILED: "cutover.state.verifyFailed",
  REVERTING: "cutover.state.reverting",
  ROLLED_BACK: "cutover.state.rolledBack",
  BLOCKED: "cutover.state.blocked",
  EXCLUDED: "cutover.state.excluded",
  CONFLICT: "cutover.state.conflict",
};

export const STATE_TONE: Record<string, BadgeTone> = {
  PLANNED: "muted",
  CERT_PENDING: "warn",
  CERT_READY: "lapis",
  READY: "gold",
  SWITCHING: "warn",
  SWITCHED: "lapis",
  VERIFIED: "ok",
  VERIFY_FAILED: "danger",
  REVERTING: "warn",
  ROLLED_BACK: "muted",
  BLOCKED: "danger",
  EXCLUDED: "muted",
  CONFLICT: "danger",
};

export const DNS_KEY: Record<string, string> = {
  source: "cutover.dns.source",
  target: "cutover.dns.target",
  mixed: "cutover.dns.mixed",
  proxied: "cutover.dns.proxied",
  tunnel: "cutover.dns.tunnel",
  unknown: "cutover.dns.unknown",
};

export const CERT_KEY: Record<string, string> = {
  unknown: "cutover.cert.unknown",
  pending: "cutover.cert.pending",
  ready: "cutover.cert.ready",
  "default-cert": "cutover.cert.defaultCert",
  untrusted: "cutover.cert.untrusted",
  "wrong-host": "cutover.cert.wrongHost",
  expired: "cutover.cert.expired",
  error: "cutover.cert.error",
};

export const BLOCK_KEY: Record<string, string> = {
  "cluster-app": "cutover.block.clusterApp",
  "tunnel-routed": "cutover.block.tunnelRouted",
  "generated-host": "cutover.block.generatedHost",
  "counterpart-not-served": "cutover.block.counterpartNotServed",
  "zone-not-covered": "cutover.block.zoneNotCovered",
  "no-dns-credential": "cutover.block.noDnsCredential",
  "caa-blocks-letsencrypt": "cutover.block.caa",
  "record-changed": "cutover.block.recordChanged",
  "record-changed-since-flip": "cutover.block.recordChangedSinceFlip",
  "data-not-done": "cutover.block.dataNotDone",
  "no-target-ip": "cutover.block.noTargetIp",
};

export const WARN_KEY: Record<string, string> = {
  "stale-aaaa-deleted": "cutover.warn.staleAaaa",
  "cname-replaced": "cutover.warn.cnameReplaced",
  "wildcard-explicit-record": "cutover.warn.wildcardExplicitRecord",
  "surplus-a-deleted": "cutover.warn.surplusADeleted",
  "proxied-kept": "cutover.warn.proxiedKept",
  "proxied-dropped": "cutover.warn.proxiedDropped",
  "ttl-not-waited": "cutover.warn.ttlNotWaited",
  "http01-gap": "cutover.warn.gapHttp01",
  stateful: "cutover.warn.stateful",
  caa: "cutover.warn.caa",
  "coverage-unverified": "cutover.warn.coverageUnverified",
  "health-pre-existing": "cutover.warn.healthPreExisting",
  "ssl-mode-weak": "cutover.warn.sslModeWeak",
  "ssl-mode-unknown": "cutover.warn.sslModeUnknown",
  "ssl-mode-bad": "cutover.warn.sslModeBad",
};

export const ROLE_KEY: Record<string, string> = {
  primary: "cutover.role.primary",
  root: "cutover.role.root",
  www: "cutover.role.www",
  alias: "cutover.role.alias",
  extra: "cutover.role.extra",
  service: "cutover.role.service",
};

/** Translate a hub code through a literal-key map; an unknown (newer) code is shown verbatim rather than hidden. */
export function tCode(t: T, map: Record<string, string>, code: string): string {
  const key = map[code];
  return key ? t(key) : t("cutover.unknownCode", { code });
}

// ── which row actions apply to which entry state ──

const FLIPPED = new Set(["SWITCHED", "VERIFIED", "VERIFY_FAILED"]);
export const isFlippable = (e: CutoverEntryView): boolean => e.state === "READY";
export const isRevertible = (e: CutoverEntryView): boolean => FLIPPED.has(e.state);
export const isFinalizable = (e: CutoverEntryView): boolean => e.state === "VERIFIED" && !e.finalizedAt;
export const isExcluded = (e: CutoverEntryView): boolean => e.state === "EXCLUDED";
export const canExclude = (e: CutoverEntryView): boolean => !isExcluded(e) && !FLIPPED.has(e.state) && e.state !== "SWITCHING" && e.state !== "REVERTING";
export const needsCounterpartFix = (e: CutoverEntryView): boolean => e.blockReason === "counterpart-not-served";

export const isRunning = (v: CutoverView | undefined | null): boolean => v?.run?.status === "running";

/** Poll cadence while a flip run is in flight. */
export const CUTOVER_POLL_MS = 3000;

/** Hostnames to act on: the selected ones that pass `pred`; with nothing selected, every entry that passes it. */
export function targetHostnames(entries: CutoverEntryView[], selected: Set<string>, pred: (e: CutoverEntryView) => boolean = () => true): string[] {
  const base = selected.size > 0 ? entries.filter((e) => selected.has(e.hostname)) : entries;
  return base.filter(pred).map((e) => e.hostname);
}

/** An http01 entry without a ready certificate: the first request after the flip can hit a certificate gap. */
export const hasHttp01Gap = (e: CutoverEntryView): boolean => e.challenge === "http01" && e.certState !== "ready";

/** Source apps that were flipped, with the hostnames that moved: the printed "stop the source" list. */
export function flippedSourceApps(entries: CutoverEntryView[]): Array<{ applicationId: string; appName: string; sourceName: string | null; hostnames: string[] }> {
  const byApp = new Map<string, { applicationId: string; appName: string; sourceName: string | null; hostnames: string[] }>();
  for (const e of entries) {
    if (!e.flippedAt || e.state === "ROLLED_BACK" || e.state === "REVERTING") continue;
    const cur = byApp.get(e.applicationId) ?? { applicationId: e.applicationId, appName: e.appName, sourceName: e.sourceName, hostnames: [] };
    cur.hostnames.push(e.hostname);
    byApp.set(e.applicationId, cur);
  }
  return [...byApp.values()];
}

export const fmtWhen = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "—");

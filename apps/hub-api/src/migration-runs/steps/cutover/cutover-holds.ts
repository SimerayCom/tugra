import type { StepEvidence } from "../../core/dto";
import type { MinioPolicy } from "../../core/run-contract";
import { isManualDns, PRE_FLIP_STATES, type Entry } from "./run-cutover-logic";

/**
 * Pure rules of CUTOVER that decide, PER HOST, whether a host may flip now (the fleet fit of grup-7): object-storage
 * dependants (R34/R61/C7), compose services that are not running yet (R13), HTTP-01 hosts whose gap nobody accepted (C10) and
 * manual-DNS hosts the operator deferred. A held host never stalls the others: it is left out of the flip and named, with the
 * input or attestation that releases it. No I/O.
 */

/** Operator attestation (subject = hostname): "this host does not depend on object storage / its object data is verified". */
export const OBJECT_CLEARED_ATTEST = "cutover.object-cleared";
/** Operator attestation (subject = hostname, or none for every host): the HTTP-01 certificate gap after the flip is accepted. Same id on TLS_PREISSUE and CUTOVER. */
export const HTTP01_GAP_ATTEST = "tls-preissue.http01-gap-accepted";
/** Operator attestation (subject = hostname, or none for every host): the DNS records of the checklist were changed. */
export const MANUAL_DNS_ATTEST = "cutover.manual-dns-switched";
/** Operator attestation (subject = hostname): leave this manual-DNS host on the source for now (it is reported as not cut over). */
export const MANUAL_DNS_DEFER_ATTEST = "cutover.manual-dns-deferred";

/**
 * Operator attestation (subject = hostname only): leave this host out of the run (it stays on the source and is reported as not cut
 * over). The per-host alternative to accepting its HTTP-01 certificate gap, so no host needs a decision that does not fit it.
 */
export const LEFT_OUT_ATTEST = "cutover.host-left-out";

/** How long a manual-DNS confirmation is trusted before the host is asked about again (the resolvers never showed the change). */
export const MANUAL_DNS_STALE_MS = 30 * 60 * 1000;

// ───────────────────────────── attestations (per host) ─────────────────────────────

/** The newest attestation of `checkId` that covers `host`: one with that subject, or (when `allowGlobal`) one without a subject. */
export function attestationFor(ev: StepEvidence, checkId: string, host: string, allowGlobal: boolean): Date | null {
  let best: Date | null = null;
  for (const a of ev.attestations) {
    if (a.checkId !== checkId) continue;
    if (a.subject !== undefined ? a.subject.toLowerCase() !== host.toLowerCase() : !allowGlobal) continue;
    const t = new Date(a.at);
    if (!Number.isNaN(t.getTime()) && (!best || t > best)) best = t;
  }
  return best;
}

export const hasAttestationFor = (ev: StepEvidence, checkId: string, host: string, allowGlobal: boolean): boolean => attestationFor(ev, checkId, host, allowGlobal) !== null;

// ───────────────────────────── object-store dependency ─────────────────────────────

const OBJECT_TOKENS = new Set(["S3", "MINIO", "BUCKET", "BUCKETS"]);

/**
 * Does an environment variable NAME point at an object store? Judged on the name only (values are secrets and are never read
 * here): a token `S3`, `MINIO`, `BUCKET`, `OBJECT STORAGE`, or `STORAGE` next to `ENDPOINT`/`URL`/`HOST`. A heuristic on purpose:
 * a false positive holds a host back and says why (the operator clears it per host with an attestation), a miss lets a host
 * flip that the list did not name, so the CUTOVER gate always shows which hosts were judged dependent and by which names.
 */
export function isObjectStoreKey(key: string): boolean {
  const tokens = key.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (tokens.some((t) => OBJECT_TOKENS.has(t))) return true;
  const joined = tokens.join("_");
  if (joined.includes("OBJECT_STORAGE") || joined.includes("OBJECTSTORAGE")) return true;
  return tokens.includes("STORAGE") && tokens.some((t) => t === "ENDPOINT" || t === "URL" || t === "HOST");
}

/** The names among `keys` that point at an object store, sorted, de-duplicated. */
export const objectStoreKeys = (keys: readonly string[]): string[] => [...new Set(keys.filter(isObjectStoreKey))].sort();

/** What the object migrations attached to the run say. */
export interface ObjectsVerification {
  /** Object migrations attached to DATA_SEED / DATA_FINAL (the ones the run can read). */
  attached: number;
  /** Buckets the owner selected for copying. */
  selectedBuckets: number;
  /** Of those, how many ended VERIFIED (`mc diff` clean). */
  verified: number;
  /** Selected buckets that ended DIFFERS or FAILED. */
  problems: number;
}

/** Every selected bucket verified and none differs: the object data is on the target and checked. Unknown (`null`) is not verified. */
export const objectsVerified = (v: ObjectsVerification | null): boolean => !!v && v.attached > 0 && v.selectedBuckets > 0 && v.verified === v.selectedBuckets && v.problems === 0;

// ───────────────────────────── holds ─────────────────────────────

/**
 *  - `object-store-hold`: the host depends on object storage and the owner's policy is `hold` (the storage stays on the source): it is NOT cut over, no wait.
 *  - `objects-unverified`: policy `mirror`, the object data is not verified yet: wait.
 *  - `service-not-running`: a compose service the import created stopped: wait until it runs.
 *  - `http01-gap-not-accepted`: HTTP-01 host without a certificate and nobody accepted the gap: wait.
 *  - `manual-dns-deferred`: the operator left a manual-DNS host on the source: not cut over, no wait.
 *  - `host-left-out`: the operator left the host out of the run: not cut over, no wait.
 */
export const HOLD_REASONS = ["host-left-out", "object-store-hold", "objects-unverified", "service-not-running", "http01-gap-not-accepted", "manual-dns-deferred"] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export interface Hold {
  hostname: string;
  reason: HoldReason;
  /** `skip`: the host stays out of this run's flip for good (reported as not cut over). `pending`: it flips once the condition clears. */
  kind: "skip" | "pending";
  /** The env names (or `object-store` for the storage service itself) that made the host an object-store dependant. */
  via?: string[];
}

/** What the rules need to know about the app behind a host. */
export interface HoldApp {
  appId: string;
  kind: "app" | "service";
  /** Application status (`RUNNING`, `STOPPED`, ...); null when unknown. */
  status: string | null;
  /** The app IS an object store (a MinIO compose service). */
  objectStore: boolean;
}

export interface HoldInput {
  entries: readonly Entry[];
  apps: ReadonlyMap<string, HoldApp>;
  /** appId -> env names that point at an object store (see {@link objectStoreKeys}). */
  objectKeys: ReadonlyMap<string, readonly string[]>;
  policy: MinioPolicy;
  objects: ObjectsVerification | null;
  cutoverEvidence: StepEvidence;
  tlsEvidence: StepEvidence;
  acceptHttp01Gap: boolean;
}

/** Hosts that depend on object storage, with the names that say so. */
export function objectDependants(entries: readonly Entry[], apps: ReadonlyMap<string, HoldApp>, objectKeys: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of entries) {
    const app = apps.get(e.applicationId);
    if (!app) continue;
    const keys = objectKeys.get(app.appId) ?? [];
    if (app.objectStore) out.set(e.hostname, ["object-store", ...keys.slice(0, 4)]);
    else if (keys.length > 0) out.set(e.hostname, keys.slice(0, 5));
  }
  return out;
}

/** Did the operator leave this host out of the run (on either step)? Per host only: a subject-less attestation never leaves every host out. */
export const isLeftOut = (hostname: string, cutover: StepEvidence, tls: StepEvidence): boolean => hasAttestationFor(cutover, LEFT_OUT_ATTEST, hostname, false) || hasAttestationFor(tls, LEFT_OUT_ATTEST, hostname, false);

const isPreFlip = (e: Entry): boolean => (PRE_FLIP_STATES as readonly string[]).includes(e.state);

/** Is the HTTP-01 certificate gap accepted for this host (the run option, or the operator's attestation on either step)? */
export const gapAccepted = (e: { hostname: string }, acceptHttp01Gap: boolean, tls: StepEvidence, cutover: StepEvidence): boolean =>
  acceptHttp01Gap || hasAttestationFor(tls, HTTP01_GAP_ATTEST, e.hostname, true) || hasAttestationFor(cutover, HTTP01_GAP_ATTEST, e.hostname, true);

/** An HTTP-01 host that has no certificate yet (its certificate can only be issued once traffic reaches the target). */
export const isGapHost = (e: Entry): boolean => e.challenge === "http01" && e.certState !== "ready";

/**
 * The holds of every host that has not flipped yet. One entry per host (the first matching rule wins, in the order object
 * store, service, TLS gap, manual deferral). Hosts past READY are never held: they flipped.
 */
export function computeHolds(i: HoldInput): Map<string, Hold> {
  const out = new Map<string, Hold>();
  const dependants = objectDependants(i.entries, i.apps, i.objectKeys);
  const verified = objectsVerified(i.objects);
  for (const e of i.entries) {
    if (!isPreFlip(e)) continue;
    const app = i.apps.get(e.applicationId);
    const hold = (reason: HoldReason, kind: Hold["kind"], via?: string[]): void => {
      out.set(e.hostname, { hostname: e.hostname, reason, kind, ...(via ? { via } : {}) });
    };
    if (isLeftOut(e.hostname, i.cutoverEvidence, i.tlsEvidence)) {
      hold("host-left-out", "skip");
      continue;
    }
    const via = dependants.get(e.hostname);
    if (via && i.policy !== "external" && !hasAttestationFor(i.cutoverEvidence, OBJECT_CLEARED_ATTEST, e.hostname, false)) {
      if (i.policy === "hold") hold("object-store-hold", "skip", via);
      else if (!verified) hold("objects-unverified", "pending", via);
      if (out.has(e.hostname)) continue;
    }
    if (app?.kind === "service" && app.status !== "RUNNING") {
      hold("service-not-running", "pending");
      continue;
    }
    if (e.state === "READY" && isGapHost(e) && !gapAccepted(e, i.acceptHttp01Gap, i.tlsEvidence, i.cutoverEvidence)) {
      hold("http01-gap-not-accepted", "pending");
      continue;
    }
    if (isManualDns(e) && hasAttestationFor(i.cutoverEvidence, MANUAL_DNS_DEFER_ATTEST, e.hostname, false)) hold("manual-dns-deferred", "skip");
  }
  return out;
}

// ───────────────────────────── flip order ─────────────────────────────

export interface FlipGroup {
  /** Target server id the group's apps run on (`""` when unknown: the default target). */
  serverId: string;
  /** 0: no host depends on object storage; 1: object-storage dependants (they flip after everything else is verified). */
  tier: 0 | 1;
  hosts: string[];
}

/**
 * The flip order of the provider-flippable hosts: one group per (tier, target server). Tier 0 (everything that does not need
 * object storage) goes first; then the dependants, whose object data is verified by then. Within a tier the servers follow
 * `serverOrder` (the run's target servers, default first). A host belongs to its app's server, so a multi-target run flips
 * one server at a time and a failure halts only that server's group.
 */
export function flipGroups(hosts: readonly Entry[], serverOf: (e: Entry) => string, dependants: ReadonlyMap<string, unknown>, serverOrder: readonly string[]): FlipGroup[] {
  const groups = new Map<string, FlipGroup>();
  for (const e of hosts) {
    const tier: 0 | 1 = dependants.has(e.hostname) ? 1 : 0;
    const serverId = serverOf(e);
    const key = `${tier}|${serverId}`;
    const g = groups.get(key) ?? { serverId, tier, hosts: [] };
    g.hosts.push(e.hostname);
    groups.set(key, g);
  }
  const idx = (id: string): number => {
    const i = serverOrder.indexOf(id);
    return i < 0 ? serverOrder.length : i;
  };
  return [...groups.values()].sort((a, b) => a.tier - b.tier || idx(a.serverId) - idx(b.serverId) || a.serverId.localeCompare(b.serverId)).map((g) => ({ ...g, hosts: g.hosts.sort() }));
}

// ───────────────────────────── manual DNS checklist ─────────────────────────────

export interface ManualHost {
  hostname: string;
  /** Newest confirmation that covers the host (its own, or a global one); null = none yet. */
  confirmedAt: Date | null;
}

/** A manual-DNS confirmation is stale when the resolvers still did not show the change `MANUAL_DNS_STALE_MS` later (the host is asked again). */
export const manualConfirmationStale = (confirmedAt: Date | null, now: Date): boolean => confirmedAt !== null && now.getTime() - confirmedAt.getTime() > MANUAL_DNS_STALE_MS;

/** The manual hosts the operator still has to act on: never confirmed, or confirmed but the change never showed (stale). */
export function manualToDo(hosts: readonly Entry[], ev: StepEvidence, now: Date): ManualHost[] {
  return hosts.map((e) => ({ hostname: e.hostname, confirmedAt: attestationFor(ev, MANUAL_DNS_ATTEST, e.hostname, true) })).filter((m) => m.confirmedAt === null || manualConfirmationStale(m.confirmedAt, now));
}

/** The manual hosts whose confirmation is fresh and whose DNS the hub should now verify against the resolvers. */
export function manualAwaitingDns(hosts: readonly Entry[], ev: StepEvidence, now: Date): string[] {
  return hosts.filter((e) => {
    const at = attestationFor(ev, MANUAL_DNS_ATTEST, e.hostname, true);
    return at !== null && !manualConfirmationStale(at, now);
  }).map((e) => e.hostname);
}

import { createHash } from "node:crypto";
import type { CutoverEntryView, CutoverView } from "../../../cutover/cutover.dto";
import type { GateCheck, GateResult, StepApprovalRecord, StepEvidence } from "../../core/dto";
import { makeGate, type GateCheckStatus } from "../../core/run-contract";

/**
 * Pure helpers shared by the cutover-side step handlers (no I/O): host classification over the cutover view, gate-check
 * builders, the timer arithmetic and the plan hash the VERIFY approval and CUTOVER are bound to.
 */

export type Entry = CutoverEntryView;
export type CutoverRunView = NonNullable<CutoverView["run"]>;

/** Cutover states in which the DNS records may carry Tugra's writes (a flip happened or is happening). */
export const FLIPPED_STATES = ["SWITCHING", "SWITCHED", "VERIFIED", "VERIFY_FAILED", "REVERTING"] as const;
export const PRE_FLIP_STATES = ["PLANNED", "CERT_PENDING", "CERT_READY", "READY"] as const;
/** Block reasons that exist only because DNS-01 could not be used for the host (an HTTP-01 fallback can lift them). */
export const DNS01_BLOCK_REASONS: readonly string[] = ["zone-not-covered", "no-dns-credential", "caa-blocks-letsencrypt"];

const stateIn = (e: Entry, list: readonly string[]): boolean => list.includes(e.state);

/** Hosts the run actually moves: everything except hosts the owner/engine excluded and rolled-back ones. */
export const trackedEntries = (es: readonly Entry[]): Entry[] => es.filter((e) => e.state !== "EXCLUDED" && e.state !== "ROLLED_BACK");
/** Tracked hosts that are not parked as BLOCKED (tunnel-routed, cluster apps, no target IP, an unfixed DNS-01 block...). */
export const actionableEntries = (es: readonly Entry[]): Entry[] => trackedEntries(es).filter((e) => e.state !== "BLOCKED");
export const isFlipped = (e: Entry): boolean => stateIn(e, FLIPPED_STATES);
export const isManualDns = (e: Entry): boolean => e.dnsMode === "manual";
export const isDns01Blocked = (e: Entry): boolean => e.state === "BLOCKED" && DNS01_BLOCK_REASONS.includes(e.blockReason ?? "");

/**
 * Does this host carry data to Tugra? `CutoverDomain.stateful` is true only while the app's data move has NOT finished,
 * so after DATA_FINAL it reads false for an app that is plainly stateful. The point of no return therefore also counts
 * every app that depends on a database or a volume (`dataApps`, from the import op's tasks).
 */
export const hostIsStateful = (e: Entry, dataApps: ReadonlySet<string>): boolean => e.stateful || dataApps.has(e.applicationId);

/**
 * Does the swap carry data to Tugra? The swap moves the WHOLE box's ingress (routers are proxy-wide), so a host parked as
 * BLOCKED is served by Tugra's proxy too: every tracked host counts, and so does any app that depends on data.
 */
export const swapIsStateful = (entries: readonly Entry[], dataApps: ReadonlySet<string>): boolean => dataApps.size > 0 || trackedEntries(entries).some((e) => hostIsStateful(e, dataApps));

/**
 * A host whose TTL the DNS preparation lowered but that never flipped (parked as BLOCKED, or still waiting): `ttlWaitUntil`
 * is set exactly while the lowered TTL has not been restored. Verified hosts are restored by `cutover.finalize`.
 */
export const hasLoweredUnflippedTtl = (e: Entry): boolean => e.dnsMode === "cloudflare" && e.ttlWaitUntil !== null && (stateIn(e, PRE_FLIP_STATES) || e.state === "BLOCKED");

/** Latest moment every lowered-TTL, unflipped, unproxied Cloudflare host's old resolver caches have expired (null = no wait). */
export function ttlWaitUntil(entries: readonly Entry[]): Date | null {
  let max: Date | null = null;
  for (const e of entries) {
    if (e.dnsMode !== "cloudflare" || !e.ttlWaitUntil || !stateIn(e, PRE_FLIP_STATES)) continue;
    const d = new Date(e.ttlWaitUntil);
    if (!Number.isNaN(d.getTime()) && (!max || d > max)) max = d;
  }
  return max;
}

/** Entries whose DNS preparation is complete: TTL set on a provider host, targetTtl noted for a manual one, or parked. */
export function isDnsPrepared(e: Entry): boolean {
  if (e.state === "EXCLUDED" || e.state === "BLOCKED" || e.state === "ROLLED_BACK") return true;
  if (e.dnsMode === "cloudflare") return e.ttlWaitUntil !== null;
  return e.targetTtl !== null;
}

// ───────────────────────────── gates ─────────────────────────────

export function chk(id: string, status: GateCheckStatus, code: string, o: Partial<Omit<GateCheck, "id" | "status" | "code">> = {}): GateCheck {
  return { id, status, code, ...o };
}

/** A gate whose only blocking checks are timer checks carries a timer wait (the engine parks the step WAITING_TIMER). */
export function timerGate(checks: readonly GateCheck[], timerCheckIds: readonly string[], notBefore: Date | null, code: string): GateResult {
  const blocking = checks.filter((c) => c.status === "fail" || c.status === "unknown");
  const onlyTimer = blocking.length > 0 && blocking.every((c) => timerCheckIds.includes(c.id));
  return makeGate(checks, onlyTimer && notBefore ? { wait: { kind: "timer", notBefore: notBefore.toISOString(), code } } : {});
}

// ───────────────────────────── hashes ─────────────────────────────

const sha256 = (parts: unknown): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/**
 * What a flip/swap approval is bound to (design step 10): the topology's own plan hash (`flipPlanHash` of the cutover
 * service, or `swapPlanHash` of proxy-swap.ts) plus the stateful host set. Exported through {@link CutoverPlanService} so
 * VERIFY derives its `inputHash` from exactly this.
 */
export function cutoverPlanHash(o: { topology: string; planHash: string; statefulHosts: readonly string[] }): string {
  return sha256(["cutover", o.topology, o.planHash, [...o.statefulHosts].sort()]);
}

export const finalizeBindingHash = (o: { runId: string; opId: string | null; verifiedHosts: readonly string[] }): string => sha256(["finalize", o.runId, o.opId, [...o.verifiedHosts].sort()]);

export const decommissionBindingHash = (o: { runId: string; sourceHost: string | null; containers: readonly string[]; controller: string; databases: ReadonlyArray<{ databaseId: string; hasSuccess: boolean }> }): string =>
  sha256(["decommission", o.runId, o.sourceHost, [...o.containers].sort(), o.controller, [...o.databases].sort((a, b) => a.databaseId.localeCompare(b.databaseId))]);

// ───────────────────────────── evidence / approval ─────────────────────────────

export const hasAttestation = (ev: StepEvidence, checkId: string): boolean => ev.attestations.some((a) => a.checkId === checkId);

/** True while a stored approval is still inside its validity window. */
export function approvalValid(a: StepApprovalRecord | null, now: Date): boolean {
  if (!a) return false;
  if (a.expiresAt === null) return true;
  const t = Date.parse(a.expiresAt);
  return Number.isFinite(t) && t > now.getTime();
}

export const iso = (d: Date): string => d.toISOString();

/** Read a string/number field of the step's compensation JSON (written by `recordCompensation`). */
export function compString(comp: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const v = comp?.[key];
  return typeof v === "string" ? v : null;
}
export function compStrings(comp: Readonly<Record<string, unknown>> | null, key: string): string[] {
  const v = comp?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
export function compDate(comp: Readonly<Record<string, unknown>> | null, key: string): Date | null {
  const s = compString(comp, key);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The earliest `verifiedAt` among verified hosts (the measured end of the downtime window), or null. */
export function earliestVerified(entries: readonly Entry[]): Date | null {
  let min: Date | null = null;
  for (const e of entries) {
    if (!e.verifiedAt) continue;
    const d = new Date(e.verifiedAt);
    if (!Number.isNaN(d.getTime()) && (!min || d < min)) min = d;
  }
  return min;
}

/** Cap a list of hostnames for a code param (params hold at most 200 items of 300 chars). */
export const capHosts = (hosts: readonly string[], max = 100): string[] => hosts.slice(0, max);

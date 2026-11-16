/**
 * The CUTOVER / OBSERVE side of the source health baseline (R52), pure. A host whose app was ALREADY degraded at the source is
 * judged against that: when it does not answer on Tugra either, it is reported as pre-existing (a warning), not as a new failure
 * that fails the step. Only HEALTH can be excused (the app answers wrongly or not at all): a certificate that does not verify,
 * a probe that errored or a host Tugra's proxy does not serve at all stays a failure, because the source's state says nothing
 * about those. A host the baseline never saw, or one that was healthy at the source, is never excused.
 */
import type { SourceBaseline } from "../../core/dto";
import { preExistingHosts } from "../import/baseline/source-health";
import type { DarkVerdict } from "./dark-probe";
import type { SwapVerify } from "./swap-runtime";

/** The reason a verified-but-excused swap host carries. */
export const PRE_EXISTING_REASON = "pre-existing";

interface EntryLite {
  hostname: string;
  applicationId: string;
}
interface AppLite {
  appId: string;
  itemRef: string | null;
}

/** hostname -> the plan itemRef of the app serving it (a host no app of the op owns has none). */
export function appRefOfHost(entries: readonly EntryLite[], apps: readonly AppLite[]): (hostname: string) => string | null {
  const ref = new Map(apps.map((a) => [a.appId, a.itemRef]));
  const app = new Map(entries.map((e) => [e.hostname, e.applicationId]));
  return (h) => {
    const id = app.get(h);
    return id ? (ref.get(id) ?? null) : null;
  };
}

/** The swap probe's verdict with the pre-existing hosts excused (`ok: true`, `reason: "pre-existing"`); only `health-*` failures qualify. */
export function excuseSwapVerify(verify: SwapVerify | null, baseline: SourceBaseline | null | undefined, entries: readonly EntryLite[], apps: readonly AppLite[]): SwapVerify | null {
  if (!verify || !baseline) return verify;
  const failing = Object.entries(verify).filter(([, v]) => !v.ok && v.reason.startsWith("health-")).map(([h]) => h);
  if (failing.length === 0) return verify;
  const excused = preExistingHosts(baseline, failing, appRefOfHost(entries, apps));
  if (excused.size === 0) return verify;
  return Object.fromEntries(Object.entries(verify).map(([h, v]) => [h, excused.has(h) ? { ok: true, reason: PRE_EXISTING_REASON } : v]));
}

/** The dark probe's verdicts with the pre-existing hosts counted ready: the certificate is valid, only the app's health is bad, and it was bad at the source. */
export function excuseDarkVerdicts(verdicts: Record<string, DarkVerdict> | null, baseline: SourceBaseline | null | undefined, entries: readonly EntryLite[], apps: readonly AppLite[]): Record<string, DarkVerdict> | null {
  if (!verdicts || !baseline) return verdicts;
  const failing = Object.entries(verdicts).filter(([, v]) => !v.ready && v.tls === "ok").map(([h]) => h);
  if (failing.length === 0) return verdicts;
  const excused = preExistingHosts(baseline, failing, appRefOfHost(entries, apps));
  if (excused.size === 0) return verdicts;
  return Object.fromEntries(Object.entries(verdicts).map(([h, v]) => [h, excused.has(h) ? { ...v, ready: true, preExisting: true } : v]));
}

/** Hostnames of a swap verification that were excused as pre-existing. */
export const excusedSwapHosts = (verify: SwapVerify | null): string[] => Object.entries(verify ?? {}).filter(([, v]) => v.ok && v.reason === PRE_EXISTING_REASON).map(([h]) => h);

/** The two-box OBSERVE flag: hosts of VERIFIED entries whose only fault is the router/health probe (`needsDeploy`) and whose app was degraded at the source. */
export function excusedBoxHosts(entries: ReadonlyArray<EntryLite & { state: string; needsDeploy: boolean }>, baseline: SourceBaseline | null | undefined, apps: readonly AppLite[]): Set<string> {
  if (!baseline) return new Set();
  const failing = entries.filter((e) => e.state === "VERIFIED" && e.needsDeploy).map((e) => e.hostname);
  return preExistingHosts(baseline, failing, appRefOfHost(entries, apps));
}

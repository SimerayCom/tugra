// The in-place takeover screen's rules (Coolify hub takeover, lane F). Pure: what each button may do, and the rollups the cards show.
// The hub re-checks everything; this only decides what is worth offering.
import type { TakeoverCertState, TakeoverItemView, TakeoverStatus, TakeoverView } from "@tugra/shared";
import type { ImportOperation } from "./types";

export type TakeoverAction = "plan" | "test" | "swap" | "verify" | "giveBack";

/** The statuses from which the owner can still give the server back. */
export const GIVE_BACK_FROM: readonly TakeoverStatus[] = ["PLANNED", "TESTING", "SWAPPING", "SWAPPED", "VERIFIED", "FAILED"];

const taking = (i: TakeoverItemView): boolean => !i.skipped;

/** May the ports be taken? Mirrors the hub's gate: something takes part, and every domain of an app that runs alongside has passed its test. */
export function canSwap(v: Pick<TakeoverView, "status" | "items">): boolean {
  if (v.status !== "TESTING") return false;
  const active = v.items.filter(taking);
  return active.length > 0 && active.every((i) => i.exclusive || i.afterSwitch || i.domains.every((d) => d.tempCheck === "ok"));
}

/** The buttons worth showing for a takeover (or none yet: only "plan"). In the order the owner should press them. */
export function actionsFor(v: TakeoverView | null | undefined): TakeoverAction[] {
  if (!v || isReversed(v)) return ["plan"];
  // a guided run drives this takeover: nothing here moves it (the hub refuses it), the screen links to the run
  if (v.runId) return [];
  const out: TakeoverAction[] = [];
  if (v.status === "PLANNED" || v.status === "TESTING" || (v.status === "FAILED" && !hasSwapped(v))) out.push("test");
  if (canSwap(v)) out.push("swap");
  if (v.status === "SWAPPED" || v.status === "VERIFIED") out.push("verify");
  if (v.giveBackAvailable && GIVE_BACK_FROM.includes(v.status)) out.push("giveBack");
  return out;
}

/** Everything was put back: given back, or a swap that failed and reversed itself. It is never tested again; a new takeover is planned. */
export const isReversed = (v: Pick<TakeoverView, "status" | "reversed">): boolean => v.status === "GIVEN_BACK" || (v.status === "FAILED" && v.reversed === true);

/** A failed takeover that never took the ports (it can be tested again). A failed give-back is not tested again, it is given back again. */
const hasSwapped = (v: TakeoverView): boolean => v.items.some((i) => i.domains.some((d) => d.cert !== "pending" || d.finalCheck !== "pending"));

export interface TakeoverRollup {
  apps: number;
  skipped: number;
  domains: number;
  tested: number;
  testFailed: number;
  checked: number;
  checkFailed: number;
  certs: Record<TakeoverCertState, number>;
}

export function rollup(v: Pick<TakeoverView, "items">): TakeoverRollup {
  const r: TakeoverRollup = { apps: 0, skipped: 0, domains: 0, tested: 0, testFailed: 0, checked: 0, checkFailed: 0, certs: { pending: 0, fallback: 0, issued: 0, failed: 0 } };
  for (const i of v.items) {
    if (i.kind === "database") continue; // counted by dbRollup
    if (i.skipped) {
      if (i.kind !== "service") r.skipped += 1; // a service left out is counted by serviceRollup
      continue;
    }
    if (i.kind !== "service") r.apps += 1; // a service's domains count here, the service itself in serviceRollup
    for (const d of i.domains) {
      r.domains += 1;
      if (d.tempCheck === "ok") r.tested += 1;
      if (d.tempCheck === "failed") r.testFailed += 1;
      if (d.finalCheck === "ok") r.checked += 1;
      if (d.finalCheck === "failed") r.checkFailed += 1;
      r.certs[d.cert] += 1;
    }
  }
  return r;
}

/** True while another press of "verify" has work to do: a domain still on the fallback, pending or failed with attempts left is for the hub to say; the screen keeps offering it until verified. */
export const verifyHasWork = (v: Pick<TakeoverView, "status" | "items">): boolean =>
  v.status === "SWAPPED" && v.items.some((i) => !i.skipped && (i.domains.some((d) => d.cert !== "issued") || (i.members ?? []).some((m) => m.ready !== "ok")));

/** Polling interval for the screen: only while something may change without a click (never when settled). */
export const pollMs = (v: Pick<TakeoverView, "status"> | null | undefined): number | false => (v && (v.status === "TESTING" || v.status === "SWAPPING" || v.status === "GIVING_BACK") ? 4000 : false);

/** The typed confirmation: the server's name, exactly (a trailing space does not matter). */
export const confirmMatches = (typed: string, serverName: string): boolean => typed.trim() === serverName.trim() && serverName.trim().length > 0;

/** An app of the import that a takeover could rebuild with Tugra instead of reusing Coolify's image. */
export interface RebuildCandidate {
  itemRef: string;
  name: string;
}

/**
 * The apps the picker offers: the import's apps that were created (done), once each, in the order the import made them. Services and
 * databases are not offered (the takeover takes apps over; a rebuild is an app's choice).
 */
export function rebuildCandidates(op: Pick<ImportOperation, "tasks"> | null | undefined): RebuildCandidate[] {
  const seen = new Set<string>();
  const out: RebuildCandidate[] = [];
  for (const t of op?.tasks ?? []) {
    if (t.kind !== "app" || t.status !== "DONE" || t.resourceType !== "application" || !t.itemRef || seen.has(t.itemRef)) continue;
    seen.add(t.itemRef);
    out.push({ itemRef: t.itemRef, name: t.name ?? t.itemRef });
  }
  return out;
}

/** Add or remove one app from the chosen set (a new array; the order of choosing is kept). */
export const toggleChoice = (chosen: readonly string[], itemRef: string): string[] => (chosen.includes(itemRef) ? chosen.filter((x) => x !== itemRef) : [...chosen, itemRef]);

/** The apps a planned takeover will rebuild (what the picker shows as chosen until the owner changes it). */
export const rebuildOf = (v: Pick<TakeoverView, "items"> | null | undefined): string[] => (v?.items ?? []).filter((i) => i.buildMode === "rebuild-verify").map((i) => i.itemRef);

/**
 * The apps that cannot be rebuilt next to Coolify's copy because they share writable data with it (the hub refuses a rebuild of one with
 * `takeover_rebuild_needs_side_by_side`): the apps an earlier plan of this server read as exclusive, and the ones the hub already refused on this screen.
 */
export function exclusiveApps(v: Pick<TakeoverView, "items"> | null | undefined, refused: readonly string[] = []): Set<string> {
  const out = new Set<string>(refused);
  for (const i of v?.items ?? []) if (i.exclusive && i.kind !== "database" && i.kind !== "service") out.add(i.itemRef);
  return out;
}

/** The databases of a takeover: how many take part and how many were checked the same after the switch. Apps are counted by {@link rollup}. */
export function dbRollup(v: Pick<TakeoverView, "items">): { total: number; ok: number; failed: number; skipped: number } {
  const dbs = v.items.filter((i) => i.kind === "database");
  const active = dbs.filter((i) => !i.skipped);
  return { total: active.length, ok: active.filter((i) => i.verify?.state === "ok").length, failed: active.filter((i) => i.verify?.state === "failed").length, skipped: dbs.length - active.length };
}

/** The compose services of a takeover: how many take part, how many are done (every container up, every database-like container answered the same) and how many are left out. */
export function serviceRollup(v: Pick<TakeoverView, "items">): { total: number; ok: number; failed: number; skipped: number } {
  const svcs = v.items.filter((i) => i.kind === "service");
  const active = svcs.filter((i) => !i.skipped);
  const members = (i: TakeoverItemView) => i.members ?? [];
  const done = (i: TakeoverItemView): boolean => members(i).length > 0 && members(i).every((m) => m.ready === "ok" && (!m.verify || m.verify.state === "ok"));
  const bad = (i: TakeoverItemView): boolean => members(i).some((m) => m.ready === "failed" || m.verify?.state === "failed");
  return { total: active.length, ok: active.filter(done).length, failed: active.filter(bad).length, skipped: svcs.length - active.length };
}

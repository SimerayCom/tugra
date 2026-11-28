/**
 * The warnings of a finished dry run, pure: which ones the operator still has to settle before the real run may start. A warning
 * is settled when it is accepted (`warning-ack` hint) or fixed (every floating image behind it has a pin). The hub enforces this on
 * `POST /migration-runs/:id/start`; the result screen shows the same list.
 */
import { WARNING_ACK_KEY } from "../steps/import/baseline/hints.dto";
import { IMAGE_PARAM_MAX, pinFor, serverRefOfItem, servicePinKey } from "../steps/import/baseline/image-pins";
import { exactPinOf } from "../steps/import/baseline/exact-images";
import type { RunHint } from "../steps/import/baseline/run-hints";
import type { CodeParams } from "./dto";

/** Codes whose `risk` param names the warning (one code carries many risks). */
const RISK_CODES: ReadonlySet<string> = new Set(["import.risk-warning", "import.item-skipped"]);

/** The stable key of a warning: its code, plus `:<risk>` for a code that carries a risk. Acceptances are stored under it. */
export function warningKeyOf(item: { code: string; params?: CodeParams | null }): string {
  const risk = item.params?.risk;
  return RISK_CODES.has(item.code) && typeof risk === "string" && risk ? `${item.code}:${risk}` : item.code;
}

/** True when the hub can store an acceptance under this key. A code outside the shape is shown but never held against Start. */
export const isAckableKey = (key: string): boolean => WARNING_ACK_KEY.safeParse(key).success;

export interface DryRunWarning {
  key: string;
  code: string;
  params: CodeParams | null;
}

/** Every `warn` item of the dry-run projections of a run's steps (info and blocking items are not warnings). */
export function warningsOf(steps: ReadonlyArray<{ progress: unknown }>): DryRunWarning[] {
  const out: DryRunWarning[] = [];
  for (const s of steps) {
    const items = (s.progress as { dryRun?: unknown } | null)?.dryRun;
    if (!Array.isArray(items)) continue;
    for (const i of items as Array<{ code?: unknown; level?: unknown; params?: unknown }>) {
      if (i?.level !== "warn" || typeof i.code !== "string") continue;
      const params = i.params && typeof i.params === "object" ? (i.params as CodeParams) : null;
      out.push({ key: warningKeyOf({ code: i.code, params }), code: i.code, params });
    }
  }
  return out;
}

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

/**
 * Is every floating image behind a warning pinned now? True only for a warning that carries its images (`imageItems` / `imageMembers` /
 * `images` / `imageCount`), whose list is whole (not cut at the param cap), and where each entry has a pin: a `service-pin` hint for a
 * stack member, an `image-pin` digest for an image app.
 */
export function imagesFixed(params: CodeParams | null, hints: readonly RunHint[]): boolean {
  const items = strings(params?.imageItems);
  const members = strings(params?.imageMembers);
  const images = strings(params?.images);
  const count = params?.imageCount;
  if (!items || !members || !images || typeof count !== "number" || items.length === 0) return false;
  if (count > IMAGE_PARAM_MAX || items.length !== count || members.length !== count || images.length !== count) return false;
  return items.every((itemRef, i) => {
    const member = members[i];
    if (member) return hints.some((h) => h.kind === "service-pin" && h.key === servicePinKey(itemRef, member)) || exactPinOf(hints, itemRef, member) !== null;
    return (images[i] !== "" && pinFor(hints, images[i], serverRefOfItem(itemRef)) !== null) || exactPinOf(hints, itemRef) !== null;
  });
}

/** The keys whose every warning is fixed (a key with one unfixed item is not). */
export function fixedKeys(steps: ReadonlyArray<{ progress: unknown }>, hints: readonly RunHint[]): string[] {
  const state = new Map<string, boolean>();
  for (const w of warningsOf(steps)) state.set(w.key, (state.get(w.key) ?? true) && imagesFixed(w.params, hints));
  return [...state.entries()].filter(([, fixed]) => fixed).map(([k]) => k).sort();
}

/**
 * The warning keys still open on a finished dry run: not accepted, not fixed, and of a shape the hub can store an acceptance for
 * (a key it cannot store has no decision to take). A key with several items is fixed only when all of them are.
 */
export function openWarnings(steps: ReadonlyArray<{ progress: unknown }>, hints: readonly RunHint[]): string[] {
  const accepted = new Set(hints.filter((h) => h.kind === "warning-ack" && h.value === "accepted").map((h) => h.key));
  const fixed = new Set(fixedKeys(steps, hints));
  return [...new Set(warningsOf(steps).map((w) => w.key))].filter((k) => isAckableKey(k) && !accepted.has(k) && !fixed.has(k)).sort();
}

/** The keys of the warnings a dry run shows (what an acceptance may name). */
export const warningKeysOf = (steps: ReadonlyArray<{ progress: unknown }>): Set<string> => new Set(warningsOf(steps).map((w) => w.key));

import type { ImportPlan } from "./types";

// What the import wizard does when a call fails because the world moved under it, instead of showing the hub's sentence and leaving the
// owner on a screen that can never work again. Pure, no React.

/** The two answers the wizard can recover from by itself: the source changed since the plan was read, or the hub session ended. */
export type ImportRecovery = "plan_changed" | "session_ended";

const codeOf = (e: unknown): string | undefined => (e && typeof e === "object" ? (e as { code?: string }).code : undefined);
const statusOf = (e: unknown): number | undefined => (e && typeof e === "object" ? (e as { status?: number }).status : undefined);

/** Which recovery a failed call asks for (by the hub's stable code), or null for any other failure. */
export function recoveryOf(e: unknown): ImportRecovery | null {
  const code = codeOf(e);
  return code === "plan_changed" || code === "session_ended" ? code : null;
}

/** The hub no longer has this session (ended, revoked or unknown): only then may the wizard forget it. An outage or a refused read keeps it. */
export const sessionGone = (e: unknown): boolean => recoveryOf(e) === "session_ended" || statusOf(e) === 404;

/** What a second read of the source found different, by item: new ones, gone ones, and ones whose own plan row changed. */
export function planDelta(prev: ImportPlan | null | undefined, next: ImportPlan): { added: number; removed: number; changed: number } {
  if (!prev) return { added: 0, removed: 0, changed: 0 };
  const before = new Map(prev.items.map((i) => [i.itemRef, JSON.stringify(i)] as const));
  let added = 0;
  let changed = 0;
  for (const i of next.items) {
    const was = before.get(i.itemRef);
    if (was === undefined) added += 1;
    else if (was !== JSON.stringify(i)) changed += 1;
  }
  const now = new Set(next.items.map((i) => i.itemRef));
  const removed = prev.items.filter((i) => !now.has(i.itemRef)).length;
  return { added, removed, changed };
}

/**
 * Pure retention planner (no I/O) shared by database, volume and hub backup pruning. Given the SUCCESS rows
 * (newest first) and a policy it returns which rows to delete and why. Three limits compose, "whichever is
 * reached first applies": keep-N copies, max age, and a total-size budget. The newest row of every series is
 * ALWAYS protected, so a prune can never leave a resource with no restorable backup.
 */

export interface RetentionRow {
  id: string;
  /** Independent keep-N / age series: the volume name for volume backups, one constant for a database or the hub. */
  series: string;
  createdAt: Date;
  sizeBytes: bigint | null;
}

export interface RetentionPolicy {
  keep: number;
  maxAgeDays: number | null;
  maxBytes: bigint | null;
}

export interface PrunePlan {
  remove: { id: string; reason: "count" | "age" | "size" }[];
  usedBytes: bigint;
  unknownSizeCount: number;
  overBudget: boolean;
}

/** "GB" everywhere in the product means GiB (1024^3). */
export const GIB = 1024n ** 3n;

const DAY_MS = 86_400_000;

export function planRetention(
  rowsNewestFirst: RetentionRow[],
  p: RetentionPolicy,
  now: number = Date.now(),
  /** Per-series override of keep / maxAgeDays (per-volume policies). The size budget stays the pool's. */
  policyOf?: (series: string) => { keep: number; maxAgeDays: number | null },
): PrunePlan {
  const remove: PrunePlan["remove"] = [];
  const removed = new Set<string>();
  const seen = new Map<string, number>(); // series -> rows seen so far (newest first)

  // 1+2. Protected newest-per-series, then the count + age pass per series.
  const protectedIds = new Set<string>();
  for (const r of rowsNewestFirst) {
    const i = seen.get(r.series) ?? 0;
    seen.set(r.series, i + 1);
    if (i === 0) {
      protectedIds.add(r.id);
      continue;
    }
    const pol = policyOf ? policyOf(r.series) : { keep: p.keep, maxAgeDays: p.maxAgeDays };
    if (i >= pol.keep) {
      remove.push({ id: r.id, reason: "count" });
      removed.add(r.id);
    } else if (pol.maxAgeDays != null && r.createdAt.getTime() < now - pol.maxAgeDays * DAY_MS) {
      remove.push({ id: r.id, reason: "age" });
      removed.add(r.id);
    }
  }

  // 3. Size pass over the survivors, pooled across series: oldest unprotected first until within budget.
  const survivors = rowsNewestFirst.filter((r) => !removed.has(r.id));
  let used = 0n;
  let unknownSizeCount = 0;
  for (const r of survivors) {
    if (r.sizeBytes == null) unknownSizeCount++;
    else used += r.sizeBytes;
  }
  if (p.maxBytes != null && used > p.maxBytes) {
    const candidates = survivors
      .filter((r) => !protectedIds.has(r.id) && r.sizeBytes != null && r.sizeBytes > 0n)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const r of candidates) {
      if (used <= p.maxBytes) break;
      remove.push({ id: r.id, reason: "size" });
      used -= r.sizeBytes!;
    }
  }

  return {
    remove,
    usedBytes: used,
    unknownSizeCount,
    overBudget: p.maxBytes != null && used > p.maxBytes,
  };
}

/** `createdBy` prefix of the rows a pre-migration safety copy writes; normal retention never prunes them (they expire with the snapshot). */
export const MIGRATION_SNAPSHOT_PREFIX = "migration-snapshot:";

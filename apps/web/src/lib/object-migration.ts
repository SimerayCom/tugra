import type { ObjectBucketView, ObjectMigrationView } from "./types";

// Pure view helpers for the object-migration screens (no network, no React): the data shaping worth unit-testing.

/** A bucket whose helper is in flight (poll fast while any is). */
export const LIVE_BUCKET_STATUSES: ReadonlySet<string> = new Set(["QUEUED", "SEEDING", "FINALIZING"]);

export function isLive(m: ObjectMigrationView | undefined): boolean {
  return !!m && (m.status === "SEEDING" || m.status === "FINALIZING" || m.status === "VERIFYING" || m.buckets.some((b) => LIVE_BUCKET_STATUSES.has(b.status)));
}

/** Largest first (unknown sizes last), then by name: the bucket table order. Never mutates. */
export function sortBySize(buckets: ObjectBucketView[]): ObjectBucketView[] {
  return [...buckets].sort((a, b) => {
    const as = a.srcBytes ?? -1;
    const bs = b.srcBytes ?? -1;
    return bs - as || (a.srcBucket < b.srcBucket ? -1 : 1);
  });
}

/** 0..100 copy progress of one bucket, or null when it is not measurable (size unknown or nothing done yet). */
export function bucketPct(b: ObjectBucketView): number | null {
  if (b.status === "SEEDED" || b.status === "FINAL" || b.status === "VERIFIED") return 100;
  if (b.srcBytes && b.srcBytes > 0 && b.doneBytes !== null) return Math.min(100, Math.round((b.doneBytes / b.srcBytes) * 100));
  if (b.srcObjects && b.srcObjects > 0 && b.doneObjects !== null) return Math.min(100, Math.round((b.doneObjects / b.srcObjects) * 100));
  return null;
}

/** Overall progress across the selected buckets (bytes when known). */
export function overallPct(m: ObjectMigrationView): number | null {
  const sel = m.buckets.filter((b) => b.selected);
  const parts = sel.map(bucketPct);
  if (sel.length === 0 || parts.some((p) => p === null)) return null;
  return Math.round(parts.reduce<number>((n, p) => n + (p ?? 0), 0) / sel.length);
}

/** What the operator can do next, from the status (the stepper's single source of truth). */
export function nextActions(m: ObjectMigrationView): { preflight: boolean; seed: boolean; final: boolean; verify: boolean; carry: boolean; cancel: boolean; select: boolean } {
  const live = isLive(m);
  const hasSel = m.buckets.some((b) => b.selected);
  const seeded = ["SEEDED", "FINAL", "DONE"].includes(m.status);
  return {
    preflight: !live && m.canWrite,
    select: !live && m.canWrite && m.status !== "DRAFT",
    seed: !live && m.canWrite && hasSel && ["PREFLIGHTED", "SEEDED", "FAILED"].includes(m.status),
    final: !live && m.canWrite && hasSel && ["SEEDED", "FINAL", "FAILED", "DONE"].includes(m.status),
    verify: !live && m.canWrite && ["SEEDED", "FINAL", "DONE", "FAILED"].includes(m.status) && m.buckets.some((b) => b.selected && ["SEEDED", "FINAL", "VERIFIED", "DIFFERS"].includes(b.status)),
    carry: !live && m.canWrite && seeded && m.buckets.some((b) => b.selected && (b.configStatus === "EXPORTED" || b.configStatus === "FAILED")),
    cancel: live && m.canWrite && m.buckets.some((b) => LIVE_BUCKET_STATUSES.has(b.status)),
  };
}

/** Does any selected bucket's destination already hold objects (a merge needs its own acknowledgement)? */
export function needsMergeAck(m: ObjectMigrationView): boolean {
  return m.buckets.some((b) => b.selected && b.status === "PENDING" && (b.dstObjects ?? 0) > 0);
}

/** Parse the exclude-globs input ("a/*, b.tmp") into the list the API takes. */
export function parseExcludes(raw: string): string[] {
  return raw.split(",").map((g) => g.trim()).filter(Boolean);
}

/**
 * Self-heal for orphaned BullMQ repeatables. When a resource (app / database / server / scheduled task) is
 * deleted, its DB row is gone but the repeatable job for it can linger in Redis and fire forever — each tick
 * the runner throws "… not found", producing a failed job and a wasted wake-up. A scheduler's worker calls
 * this before running: if the row no longer exists it unschedules the repeatable and skips the run.
 *
 * Fail-safe: `exists` is awaited, so a transient DB error propagates (the job fails and the schedule is kept)
 * rather than being mistaken for a deleted row and unscheduled. Only a definitive `false` unschedules.
 */
export async function reapIfGone(
  id: string,
  exists: () => Promise<boolean>,
  unschedule: (id: string) => Promise<void>,
): Promise<boolean> {
  if (await exists()) return true;
  await unschedule(id);
  return false;
}

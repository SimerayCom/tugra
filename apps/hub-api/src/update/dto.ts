import { z } from "zod";

/**
 * The owner-facing update status returned by GET /instance/update. `latest`/`changelogUrl` are null until
 * the first successful signed check populates the cache. `updateAvailable` is computed from the RUNNING
 * build, so a stale/older manifest can never report an update (downgrade guard).
 */
export const UpdateStatusViewSchema = z.object({
  current: z.string(),
  latest: z.string().nullable(),
  channel: z.string(),
  updateAvailable: z.boolean(),
  changelogUrl: z.string().nullable(),
  autoUpdate: z.boolean(),
});
export type UpdateStatusView = z.infer<typeof UpdateStatusViewSchema>;

/**
 * Result of POST /instance/update (starting the updater). `started` = the update was queued for the sidecar;
 * the terminal states report why nothing was started (never a downgrade, nothing newer, an update already
 * running, the check unconfigured/failed, or an auto-check declining a non-patch bump).
 */
export const UpdateApplyResultSchema = z.object({
  status: z.enum(["started", "up-to-date", "in-progress", "unconfigured", "error", "notify-only", "needs-intermediate"]),
  targetVersion: z.string().nullable(),
});
export type UpdateApplyResult = z.infer<typeof UpdateApplyResultSchema>;

/** Live update progress (GET /instance/update/stream, from the Redis status the sidecar writes). */
export const UpdateProgressSchema = z.object({
  phase: z.enum(["idle", "queued", "pulling", "recreating", "done", "failed"]),
  targetVersion: z.string().nullable(),
  error: z.string().nullable(),
});
export type UpdateProgress = z.infer<typeof UpdateProgressSchema>;

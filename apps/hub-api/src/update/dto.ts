import { z } from "zod";

/**
 * The owner-facing update status returned by GET /instance/update. `latest`/`changelogUrl` are null until
 * the first successful signed check populates the cache. `updateAvailable` is computed from the RUNNING
 * build, so a stale/older manifest can never report an update (downgrade guard).
 */
/** A signed operator notice surfaced to the owner (plain text + optional https link). Null when none/expired. */
export const UpdateNoticeViewSchema = z.object({
  id: z.string(),
  message: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  url: z.string().nullable(),
});
export type UpdateNoticeView = z.infer<typeof UpdateNoticeViewSchema>;

export const UpdateStatusViewSchema = z.object({
  current: z.string(),
  latest: z.string().nullable(),
  channel: z.string(),
  // "auto" = the owner never pinned a channel (updateChannel NULL): `channel` was derived from the running build.
  channelSource: z.enum(["auto", "explicit"]),
  updateAvailable: z.boolean(),
  changelogUrl: z.string().nullable(),
  autoUpdate: z.boolean(),
  notice: UpdateNoticeViewSchema.nullable(),
  // false when TUGRA_UPDATE_CHECKS=0 or the manifest URL/key pair is unconfigured.
  checksEnabled: z.boolean(),
  checkIntervalMin: z.number().int().positive(),
  // ISO 8601 of the last SUCCESSFUL signed check (null = never) and the short reason the latest attempt failed.
  lastCheckedAt: z.string().nullable(),
  lastCheckError: z.string().nullable(),
});
export type UpdateStatusView = z.infer<typeof UpdateStatusViewSchema>;

/**
 * The member-facing slice of the update status (GET /instance/version): what every signed-in user may see
 * so the shell can show the running version under the logo and an "update available" hint. No preferences
 * (channel policy, auto-update, notice, changelog link) — those stay owner-only.
 */
export const MemberVersionViewSchema = UpdateStatusViewSchema.pick({ current: true, channel: true, latest: true, updateAvailable: true });
export type MemberVersionView = z.infer<typeof MemberVersionViewSchema>;

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
  phase: z.enum(["idle", "queued", "pulling", "recreating", "done", "failed", "recovery_required"]),
  targetVersion: z.string().nullable(),
  error: z.string().nullable(),
});
export type UpdateProgress = z.infer<typeof UpdateProgressSchema>;

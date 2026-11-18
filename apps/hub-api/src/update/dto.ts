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
 * The update helper (`tugra-updater` sidecar) as the hub last saw it, via the local agent. `behind` = it runs an older
 * release than this hub: after an update the hub then refreshes it by itself (see StackConvergeService), and a helper
 * that predates self-refresh could otherwise only be fixed by re-running scripts/install.sh. `state`: unknown (never
 * probed / no sidecar), current, behind (will be refreshed), refreshing (the refresh was just scheduled) or failed
 * (the last refresh attempt did not go through — the notice then points at the installer).
 */
export const UpdaterViewSchema = z.object({
  version: z.string().nullable(),
  behind: z.boolean(),
  state: z.enum(["unknown", "current", "behind", "refreshing", "failed"]),
  checkedAt: z.string().nullable(),
});
export type UpdaterView = z.infer<typeof UpdaterViewSchema>;

/**
 * A half-finished update the update helper found: the install's .env names `envVersion` but the running hub/web are still
 * on `runningVersion` (an older updater wrote .env before pulling, then the pull failed - typically a full disk). The panel
 * then offers "Finish update"; the next update resumes it (or puts .env back to the running release when the target cannot
 * be pulled). Null when none, or when the running hub is already on that version.
 */
export const HalfUpdateViewSchema = z.object({ envVersion: z.string(), runningVersion: z.string() });
export type HalfUpdateView = z.infer<typeof HalfUpdateViewSchema>;

/** GET/PATCH /instance/update + POST /instance/update/check: the status plus the update helper's own version. */
export const OwnerUpdateStatusViewSchema = UpdateStatusViewSchema.extend({ updater: UpdaterViewSchema, halfUpdate: HalfUpdateViewSchema.nullable() });
export type OwnerUpdateStatusView = z.infer<typeof OwnerUpdateStatusViewSchema>;

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

/**
 * Live update progress (GET /instance/update/stream, from the Redis status the sidecar writes). `error` is the human cause of
 * a failure (never empty on `failed`); `code` is its machine kind, `disk_space` today (the disk preflight refused, or the disk
 * filled up while pulling), with the measured `needBytes` / `haveBytes` and the `path` they were measured on when known.
 */
export const UpdateProgressSchema = z.object({
  phase: z.enum(["idle", "queued", "pulling", "recreating", "done", "failed", "recovery_required"]),
  targetVersion: z.string().nullable(),
  error: z.string().nullable(),
  code: z.string().nullable(),
  needBytes: z.number().nullable(),
  haveBytes: z.number().nullable(),
  path: z.string().nullable(),
});
export type UpdateProgress = z.infer<typeof UpdateProgressSchema>;

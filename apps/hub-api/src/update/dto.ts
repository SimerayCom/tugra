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

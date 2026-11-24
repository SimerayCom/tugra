import { z } from "zod";
import { REMOTE_SOURCE_KINDS } from "../dto";

/** Preview the settings a connected source can carry. `opId` (an import operation of the caller's) lets tasks and tags
 *  find the apps that were imported; without it they are shown as "available after the apps are imported". */
export const ImportSettingsPreviewSchema = z.object({
  sessionId: z.string().min(1),
  sourceKind: z.enum(REMOTE_SOURCE_KINDS).optional(),
  opId: z.string().min(1).optional(),
  /** The team the import lands in (the target server's team). Checked for `apps:config`; ignored when `opId` names the team. */
  teamId: z.string().min(1).max(100).optional(),
});
export type ImportSettingsPreviewInput = z.infer<typeof ImportSettingsPreviewSchema>;

const entryId = z.string().min(1).max(300);

/**
 * Apply the entries the operator selected. Secrets are never part of this request except what the SOURCE cannot give
 * (the S3 access key and secret, which Coolify's API never returns); they are encrypted by the destination service on
 * the way in. Everything else is re-read from the source on the hub.
 */
export const ImportSettingsApplySchema = z.object({
  sessionId: z.string().min(1),
  sourceKind: z.enum(REMOTE_SOURCE_KINDS).optional(),
  opId: z.string().min(1).optional(),
  teamId: z.string().min(1).max(100).optional(),
  select: z.array(entryId).min(1).max(500),
  /** Source server ref -> Tugra server id (server settings). */
  serverMap: z.record(z.string().min(1).max(200), z.string().min(1).max(100)).optional(),
  /** Entry id -> the S3 credentials for that storage. */
  s3Credentials: z.record(entryId, z.object({ accessKey: z.string().min(1).max(512), secretKey: z.string().min(1).max(1024) }).strict()).optional(),
  /** Entry id -> the role to invite a member with (never OWNER: ownership is not handed over by an import). */
  memberRoles: z.record(entryId, z.enum(["ADMIN", "VIEWER"])).optional(),
  /** Must be true for any selected member: invitations send email, so they are never sent without this confirmation. */
  confirmInvites: z.boolean().optional(),
});
export type ImportSettingsApplyInput = z.infer<typeof ImportSettingsApplySchema>;

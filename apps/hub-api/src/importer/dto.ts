import { z } from "zod";

/**
 * The REMOTE (copy-mode) source PaaS kinds the importer can connect to over an API with a stored session.
 * `local-docker` is deliberately NOT here — it adopts live containers in place and has no session/token.
 * The importer service and the apply executor derive their source-dispatch from this one list (the MCP tools
 * and web wizard are widened alongside the schemas below when a second kind lands).
 * Coolify is the only member today; a second kind (dokploy) is added here and in the schemas below together.
 */
export const REMOTE_SOURCE_KINDS = ["coolify"] as const;
export type RemoteSourceKind = (typeof REMOTE_SOURCE_KINDS)[number];
export const isRemoteSourceKind = (k: string | undefined | null): k is RemoteSourceKind =>
  !!k && (REMOTE_SOURCE_KINDS as readonly string[]).includes(k);

/** Connect an external source PaaS (store an encrypted, short-lived session). Coolify so far. */
export const ImportConnectSchema = z.object({
  sourceKind: z.literal("coolify"),
  teamId: z.string().min(1),
  baseUrl: z.string().url().max(2048),
  token: z.string().min(1).max(4096),
});
export type ImportConnectInput = z.infer<typeof ImportConnectSchema>;

/** Request body for the dry-run import plan: a local server to adopt, or a connected remote session. */
export const ImportPlanRequestSchema = z.discriminatedUnion("sourceKind", [
  z.object({ sourceKind: z.literal("local-docker"), serverId: z.string().min(1) }),
  z.object({ sourceKind: z.literal("coolify"), sessionId: z.string().min(1) }),
]);
export type ImportPlanRequestInput = z.infer<typeof ImportPlanRequestSchema>;

/** Apply a previously-previewed plan. `planHash` binds the apply to the exact plan the caller reviewed:
 *  the server re-plans and refuses (409) if the source changed since. local-docker adopts in place; coolify
 *  COPIES each app onto `targetServerId` (a fresh Tugra server/cluster). */
const planHash = z.string().regex(/^[a-f0-9]{32}$/, "invalid planHash");
export const ImportApplySchema = z.discriminatedUnion("sourceKind", [
  z.object({ sourceKind: z.literal("local-docker"), serverId: z.string().min(1), planHash }),
  z.object({
    sourceKind: z.literal("coolify"),
    sessionId: z.string().min(1),
    targetServerId: z.string().min(1),
    environmentId: z.string().min(1).optional(),
    planHash,
  }),
]);
export type ImportApplyInput = z.infer<typeof ImportApplySchema>;

/** Confirm body for the env-remap apply. `confirmToken` is the planHash the operator reviewed in the
 *  preview (a sha256 hex digest, 64 chars — distinct from the 32-char import planHash); the apply re-plans
 *  and refuses (409) if it no longer matches, so a stale diff is never written. */
export const ImportRemapEnvSchema = z.object({
  confirmToken: z.string().regex(/^[a-f0-9]{64}$/, "invalid confirmToken"),
});
export type ImportRemapEnvInput = z.infer<typeof ImportRemapEnvSchema>;

import { z } from "zod";

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

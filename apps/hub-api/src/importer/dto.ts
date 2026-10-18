import { z } from "zod";

/** Request body for the dry-run import plan. Only `local-docker` is wired so far (S4b); the remote source
 *  adapters (Coolify/Dokploy/…) land in later slices and will extend this union. */
export const ImportPlanRequestSchema = z.object({
  sourceKind: z.literal("local-docker"),
  serverId: z.string().min(1),
});
export type ImportPlanRequestInput = z.infer<typeof ImportPlanRequestSchema>;

/** Apply a previously-previewed plan. `planHash` binds the apply to the exact plan the caller reviewed:
 *  the server re-plans and refuses (409) if the host changed since. */
export const ImportApplySchema = z.object({
  sourceKind: z.literal("local-docker"),
  serverId: z.string().min(1),
  planHash: z.string().regex(/^[a-f0-9]{32}$/, "invalid planHash"),
});
export type ImportApplyInput = z.infer<typeof ImportApplySchema>;

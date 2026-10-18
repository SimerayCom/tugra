import { z } from "zod";

/** Request body for the dry-run import plan. Only `local-docker` is wired so far (S4b); the remote source
 *  adapters (Coolify/Dokploy/…) land in later slices and will extend this union. */
export const ImportPlanRequestSchema = z.object({
  sourceKind: z.literal("local-docker"),
  serverId: z.string().min(1),
});
export type ImportPlanRequestInput = z.infer<typeof ImportPlanRequestSchema>;

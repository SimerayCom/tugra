import { z } from "zod";

/** Where the safety copy goes: a team destination, or `null` for the target server's own disk. `skip` records an explicit "no copy". */
export const PlanSnapshotSchema = z
  .object({
    destinationId: z.string().min(1).nullable(),
    skip: z.boolean().default(false),
  })
  .strict();
export type PlanSnapshotInput = z.infer<typeof PlanSnapshotSchema>;

export const RestoreSnapshotSchema = z.object({ itemId: z.string().min(1) }).strict();
export type RestoreSnapshotInput = z.infer<typeof RestoreSnapshotSchema>;

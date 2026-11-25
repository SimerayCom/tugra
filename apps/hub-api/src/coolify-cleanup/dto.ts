import { z } from "zod";

/** The owner's confirmation: the server's exact name and the fingerprint of the list they saw. */
export const ConfirmSchema = z
  .object({
    confirm: z.string().min(1).max(200),
    listHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ConfirmInput = z.infer<typeof ConfirmSchema>;

import { z } from "zod";

export const CleanupConfigSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(24 * 30).optional(),
  volumes: z.boolean().optional(),
});
export type CleanupConfigInput = z.infer<typeof CleanupConfigSchema>;

import { z } from "zod";

export const BackupConfigSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(24 * 30).optional(),
  retention: z.number().int().min(1).max(365).optional(),
  destinationId: z.string().nullable().optional(),
});
export type BackupConfigInput = z.infer<typeof BackupConfigSchema>;

import { z } from "zod";

export const VolumeBackupConfigSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(720).nullable().optional(),
  retention: z.number().int().min(1).max(365).optional(),
  destinationId: z.string().nullable().optional(),
});
export type VolumeBackupConfigInput = z.infer<typeof VolumeBackupConfigSchema>;

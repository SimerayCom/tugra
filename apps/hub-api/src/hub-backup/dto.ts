import { z } from "zod";

export const HubBackupConfigSchema = z
  .object({
    enabled: z.boolean(),
    intervalHours: z.number().int().min(1).max(24 * 30).default(24),
    retention: z.number().int().min(1).max(365).default(7),
    destinationId: z.string().min(1).nullable().optional(), // null / absent => LOCAL (/etc/tugra/backups/hub)
  })
  .strict();
export type HubBackupConfigInput = z.infer<typeof HubBackupConfigSchema>;

import { z } from "zod";
import { VOL_CRON } from "../volume-backups/dto";

export const HubBackupConfigSchema = z
  .object({
    enabled: z.boolean(),
    intervalHours: z.number().int().min(1).max(24 * 30).default(24),
    // Optional 5-field cron (1h floor) wins over intervalHours; absent leaves the stored value, null clears it.
    cron: VOL_CRON.nullable().optional(),
    retention: z.number().int().min(1).max(365).default(7),
    // Also delete backups older than N days / beyond a total size (GiB); absent leaves, null clears. The newest is kept.
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    maxSizeGb: z.number().int().min(1).max(100000).nullable().optional(),
    destinationId: z.string().min(1).nullable().optional(), // null / absent => LOCAL (/etc/tugra/backups/hub)
    // Optional third copy: every run also writes here. Absent leaves the stored value, null clears it.
    extraDestinationId: z.string().min(1).nullable().optional(),
    // Monthly restore drill; absent leaves the stored value.
    drillEnabled: z.boolean().optional(),
  })
  .strict();
export type HubBackupConfigInput = z.infer<typeof HubBackupConfigSchema>;

// Sealed export of destination data keys. The passphrase seals the file (openssl enc compatible); it is never stored or logged.
export const DestinationKeysExportSchema = z.object({ passphrase: z.string().min(12).max(256) }).strict();
export type DestinationKeysExportInput = z.infer<typeof DestinationKeysExportSchema>;

// The dead-man check-in. `url` absent keeps the stored address, null clears it; it is a secret (never returned).
export const HubDeadmanSchema = z
  .object({
    enabled: z.boolean(),
    intervalMinutes: z.number().int().min(1).max(60).default(5),
    url: z.string().min(8).max(2000).nullable().optional(),
  })
  .strict();
export type HubDeadmanInput = z.infer<typeof HubDeadmanSchema>;

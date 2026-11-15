import { z } from "zod";
import { CRON } from "../backups/dto";
import { minCronGapMs } from "../common/cron";

/** The same 5-field validator the database schedule uses, plus a one-hour frequency floor: a volume tar (and the
 *  hub dump) is far heavier than a DB dump, so "* * * * *" must not be schedulable. */
export const VOL_CRON = CRON.refine((c) => (minCronGapMs(c) ?? 0) >= 3_600_000, "may run at most once an hour");

const INTERVAL = z.number().int().min(1).max(720).nullable().optional();
const RETENTION_DAYS = z.number().int().min(1).max(3650).nullable().optional();
const MAX_SIZE_GB = z.number().int().min(1).max(100000).nullable().optional();

// cron / retentionDays / maxSizeGb: absent leaves the stored value, null clears it. intervalHours keeps its
// historical "absent = cleared" semantics.
export const VolumeBackupConfigSchema = z.object({
  enabled: z.boolean(),
  intervalHours: INTERVAL,
  cron: VOL_CRON.nullable().optional(),
  retention: z.number().int().min(1).max(365).optional(),
  retentionDays: RETENTION_DAYS,
  maxSizeGb: MAX_SIZE_GB,
  destinationId: z.string().nullable().optional(),
});
export type VolumeBackupConfigInput = z.infer<typeof VolumeBackupConfigSchema>;

// Per-volume policy. null/absent retention fields inherit the app's; an enabled policy with neither cron nor
// intervalHours inherits the app schedule and overrides retention only.
export const VolumePolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    intervalHours: INTERVAL,
    cron: VOL_CRON.nullable().optional(),
    retention: z.number().int().min(1).max(365).nullable().optional(),
    retentionDays: RETENTION_DAYS,
    maxSizeGb: MAX_SIZE_GB,
  })
  .strict();
export type VolumePolicyInput = z.infer<typeof VolumePolicySchema>;

// Import an app volume's data from an external tar(.gz) URL (migrator data-pull).
// Overwrites the target volume. Mirrors the DB ImportFromUrlSchema + a volumeName.
export const VolumeImportFromUrlSchema = z
  .object({
    volumeName: z.string().min(1).max(100),
    url: z.string().url(),
    gzip: z.boolean().default(true),
    encrypted: z.boolean().default(false),
    encryptionKey: z.string().optional(),
  })
  .refine((d) => !d.encrypted || !!d.encryptionKey, {
    message: "encryptionKey is required when encrypted is true",
  });
export type VolumeImportFromUrlInput = z.infer<typeof VolumeImportFromUrlSchema>;

// Generate a presigned migration URL for an existing S3 volume backup.
export const ExportUrlSchema = z.object({
  expireHours: z.number().int().min(1).max(168).optional(), // default 24; S3 presigned max = 7 days
});
export type ExportUrlInput = z.infer<typeof ExportUrlSchema>;

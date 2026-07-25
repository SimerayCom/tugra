import { z } from "zod";

export const BackupConfigSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(24 * 30).optional(),
  retention: z.number().int().min(1).max(365).optional(),
  destinationId: z.string().nullable().optional(),
});
export type BackupConfigInput = z.infer<typeof BackupConfigSchema>;

// Apply one backup schedule to many databases (fleet bulk op). destinationId is
// intentionally excluded — destinations are team-scoped, so a single one can't
// validly apply across databases in different teams; each db keeps its own.
export const BackupConfigBulkSchema = z.object({
  databaseIds: z.array(z.string().min(1)).min(1),
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(24 * 30).optional(),
  retention: z.number().int().min(1).max(365).optional(),
});
export type BackupConfigBulkInput = z.infer<typeof BackupConfigBulkSchema>;

export const ImportFromUrlSchema = z
  .object({
    url: z.string().url(),
    gzip: z.boolean().default(true),
    encrypted: z.boolean().default(false),
    encryptionKey: z.string().optional(),
  })
  .refine((d) => !d.encrypted || !!d.encryptionKey, {
    message: "encryptionKey is required when encrypted is true",
  });
export type ImportFromUrlInput = z.infer<typeof ImportFromUrlSchema>;

// Generate a presigned migration URL for an existing S3 database backup.
export const ExportUrlSchema = z.object({
  expireHours: z.number().int().min(1).max(168).optional(), // default 24; S3 presigned max = 7 days
});
export type ExportUrlInput = z.infer<typeof ExportUrlSchema>;

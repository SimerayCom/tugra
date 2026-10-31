import { z } from "zod";

// 5-field cron (minute hour day-of-month month day-of-week) — same shape the server-ops cleanup DTO uses.
// When set it overrides intervalHours ("daily at 03:00" instead of "every 24h"); null clears it.
const CRON = z.string().regex(/^\s*(\S+\s+){4}\S+\s*$/, "must be a 5-field cron expression");

export const BackupConfigSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(24 * 30).optional(),
  cron: CRON.nullable().optional(),
  retention: z.number().int().min(1).max(365).optional(),
  // Also delete SUCCESS backups older than N days (alongside the keep-N count); null clears it.
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
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
    // Postgres only: force the restore mode for a foreign dump whose extension lies. Coolify names its
    // custom-format (pg_dump -Fc) dumps `.dmp`, which the extension sniff would misread as plain SQL and
    // feed to psql — failing on the binary archive. Set "custom" for such dumps, "sql" for a plain SQL file.
    pgFormat: z.enum(["custom", "sql"]).optional(),
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

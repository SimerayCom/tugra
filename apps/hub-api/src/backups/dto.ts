import { z } from "zod";
import { isValidCron, minCronGapMs } from "../common/cron";

// 5-field cron (minute hour day-of-month month day-of-week) — same shape the server-ops cleanup DTO uses.
// When set it overrides intervalHours ("daily at 03:00" instead of "every 24h"); null clears it.
// The regex fixes the shape; `isValidCron` rejects out-of-range fields that would crash the scheduler.
// Exported so the verify-config DTO reuses the exact same validator (accepted ⇒ schedulable).
export const CRON = z
  .string()
  .regex(/^\s*(\S+\s+){4}\S+\s*$/, "must be a 5-field cron expression")
  .refine(isValidCron, "cron expression is not valid (check the field ranges)");

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

// Minimum interval between scheduled restore-verify drills. Floored FAR above the backup minimum (1h):
// each drill provisions + restores + tears down a REAL database, so it must stay sparse to spare the host.
export const VERIFY_MIN_HOURS = 12;

// Scheduled restore-verify drill config. No retention/destination — a drill retains nothing and reads the
// chosen backup's own destination per-backup. The cron is floored to the SAME minimum as the plain interval:
// otherwise a cron like "* * * * *" would bypass VERIFY_MIN_HOURS and provision+restore+tear-down a real
// database every minute.
export const VerifyConfigSchema = z
  .object({
    enabled: z.boolean(),
    intervalHours: z.number().int().min(VERIFY_MIN_HOURS).max(24 * 30).optional(),
    cron: CRON.nullable().optional(),
  })
  .refine((c) => !c.cron || (minCronGapMs(c.cron) ?? 0) >= VERIFY_MIN_HOURS * 3_600_000, {
    message: `the verify cron may run at most once every ${VERIFY_MIN_HOURS} hours (each run provisions a real database)`,
    path: ["cron"],
  });
export type VerifyConfigInput = z.infer<typeof VerifyConfigSchema>;

// PITR (point-in-time recovery) switch for a Postgres database. Enabling recreates the container with WAL
// archiving on (a one-time restart), verifies archiving end to end and auto-rolls back on failure. Disabling
// drains the un-shipped spool to the destination first; `purgeSpool` explicitly accepts dropping any WAL that
// could not be shipped (default false — un-shipped WAL is never deleted silently).
export const PitrConfigSchema = z.object({
  enabled: z.boolean(),
  purgeSpool: z.boolean().optional(),
});
export type PitrConfigInput = z.infer<typeof PitrConfigSchema>;

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

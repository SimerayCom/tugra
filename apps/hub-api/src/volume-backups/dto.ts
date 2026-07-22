import { z } from "zod";

export const VolumeBackupConfigSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(720).nullable().optional(),
  retention: z.number().int().min(1).max(365).optional(),
  destinationId: z.string().nullable().optional(),
});
export type VolumeBackupConfigInput = z.infer<typeof VolumeBackupConfigSchema>;

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

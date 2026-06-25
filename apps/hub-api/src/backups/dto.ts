import { z } from "zod";

export const BackupConfigSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(24 * 30).optional(),
  retention: z.number().int().min(1).max(365).optional(),
  destinationId: z.string().nullable().optional(),
});
export type BackupConfigInput = z.infer<typeof BackupConfigSchema>;

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

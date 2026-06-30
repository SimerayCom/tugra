import { z } from "zod";

export const CleanupConfigSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(24 * 30).optional(),
  volumes: z.boolean().optional(),
});
export type CleanupConfigInput = z.infer<typeof CleanupConfigSchema>;

// Apply the same cleanup schedule to many servers at once (fleet bulk op).
export const CleanupConfigBulkSchema = CleanupConfigSchema.extend({
  serverIds: z.array(z.string().min(1)).min(1),
});
export type CleanupConfigBulkInput = z.infer<typeof CleanupConfigBulkSchema>;

export const CreateLogDrainSchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().url(),
  token: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});
export type CreateLogDrainInput = z.infer<typeof CreateLogDrainSchema>;

export const UpdateLogDrainSchema = z.object({
  name: z.string().min(1).optional(),
  endpoint: z.string().url().optional(),
  token: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateLogDrainInput = z.infer<typeof UpdateLogDrainSchema>;

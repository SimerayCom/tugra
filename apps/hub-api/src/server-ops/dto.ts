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

// The drain target format the agent ships to. "http" = Tugra's generic batch JSON; "loki" = Grafana Loki
// push API; "datadog" = Datadog logs intake (token is sent as DD-API-KEY, not a Bearer). syslog (a non-HTTP
// transport) is planned. For loki/datadog the `endpoint` is that provider's push/intake URL.
export const LOG_DRAIN_TYPES = ["http", "loki", "datadog"] as const;

export const CreateLogDrainSchema = z.object({
  name: z.string().min(1),
  type: z.enum(LOG_DRAIN_TYPES).default("http"),
  endpoint: z.string().url(),
  token: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});
export type CreateLogDrainInput = z.infer<typeof CreateLogDrainSchema>;

export const UpdateLogDrainSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(LOG_DRAIN_TYPES).optional(),
  endpoint: z.string().url().optional(),
  token: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateLogDrainInput = z.infer<typeof UpdateLogDrainSchema>;

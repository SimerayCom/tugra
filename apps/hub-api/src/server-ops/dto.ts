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

// Check or apply OS package updates across many servers at once (fleet bulk op). Capped to keep a
// single request's fan-out bounded; each server is still role-gated per team (non-writable skipped).
export const FleetPatchSchema = z.object({
  serverIds: z.array(z.string().min(1)).min(1).max(100),
});
export type FleetPatchInput = z.infer<typeof FleetPatchSchema>;

// Fleet overview: one call returns the newest metrics sample per server (joined client-side with the
// server list). Mirrors the MetricsSample wire shape from @tugra/shared.
export const MetricsSampleSchema = z.object({
  ts: z.number(),
  cpu: z.number(),
  memUsed: z.number(),
  memTotal: z.number(),
  diskUsed: z.number(),
  diskTotal: z.number(),
  netRx: z.number(),
  netTx: z.number(),
  diskRead: z.number(),
  diskWrite: z.number(),
  temp: z.number().optional(),
  sensors: z.record(z.number()).optional(),
  gpus: z
    .array(z.object({ name: z.string(), util: z.number(), memUsed: z.number(), memTotal: z.number(), temp: z.number().optional(), power: z.number().optional() }))
    .optional(),
  battery: z.object({ percent: z.number(), state: z.string() }).nullable().optional(),
});
export const FleetLatestRowSchema = z.object({
  serverId: z.string(),
  sample: MetricsSampleSchema,
});

// Lifecycle action on one container from the server's Containers tab. `remove` needs confirmName
// (type-to-confirm) and is only allowed on foreign containers (service-side guard).
export const ContainerActionSchema = z.object({
  container: z.string().min(1).max(128),
  action: z.enum(["start", "restart", "stop", "remove"]),
  confirmName: z.string().optional(),
});
export type ContainerActionInput = z.infer<typeof ContainerActionSchema>;

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

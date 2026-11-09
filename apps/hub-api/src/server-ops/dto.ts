import { z } from "zod";
import { isValidCron } from "../common/cron";

// 5-field cron (minute hour day-of-month month day-of-week) — same shape the scheduled-tasks DTO accepts.
// The regex fixes the shape; `isValidCron` rejects out-of-range fields that would crash the scheduler.
const cleanupCron = z
  .string()
  .regex(/^\s*(\S+\s+){4}\S+\s*$/, "must be a 5-field cron expression")
  .refine(isValidCron, "cron expression is not valid (check the field ranges)");

export const CleanupConfigSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(24 * 30).optional(),
  // When set, the cron expression drives the schedule and overrides intervalHours; null clears it.
  cron: cleanupCron.nullable().optional(),
  // Scheduled runs only prune when disk usage % is at/above this; null clears it. Manual runs ignore it.
  thresholdPct: z.number().int().min(1).max(100).nullable().optional(),
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
  load1: z.number().optional(),
  load5: z.number().optional(),
  load15: z.number().optional(),
  swapUsed: z.number().optional(),
  swapTotal: z.number().optional(),
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

// Fleet sparkline source: each server's recent per-minute CPU / memory % (one batch call, bounded window).
export const FleetTrendRowSchema = z.object({
  serverId: z.string(),
  points: z.array(z.object({ ts: z.number(), cpu: z.number(), mem: z.number().nullable() })),
});

// Cross-fleet "hottest containers": the live containers across every visible server, ranked by CPU.
export const FleetHottestContainerSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  containerName: z.string(),
  label: z.string(),
  kind: z.enum(["app", "db", "system", "other"]),
  resourceId: z.string().optional(),
  service: z.string().optional(),
  cpu: z.number(),
  memUsed: z.number(),
  memTotal: z.number(),
  memPct: z.number(),
  netRx: z.number(),
  netTx: z.number(),
  blkRead: z.number(),
  blkWrite: z.number(),
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

// Operator-authored Traefik dynamic-config file (Coolify "Proxy > Dynamic Configurations" parity). The name
// is a slug (lowercase alnum + `-`, no dots/slashes/extension) — the file on disk is `user-<name>.yml`, so it
// can never collide with a Tugra-managed file. Content is validated as parseable YAML in the service.
export const PROXY_DYNAMIC_NAME_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;
export const ProxyDynamicNameSchema = z
  .string()
  .regex(PROXY_DYNAMIC_NAME_RE, "name must be a lowercase slug (a-z, 0-9, -), 1–49 chars, no extension");
export const SetProxyDynamicConfigSchema = z
  .object({ content: z.string().min(1).max(64_000) })
  .strict();
export type SetProxyDynamicConfigInput = z.infer<typeof SetProxyDynamicConfigSchema>;

// Traffic Analytics (proxy access log) per-server toggle. The response says whether the proxy re-apply landed.
export const SetTrafficAnalyticsSchema = z.object({ enabled: z.boolean() }).strict();
export type SetTrafficAnalyticsInput = z.infer<typeof SetTrafficAnalyticsSchema>;
export const TrafficAnalyticsStateSchema = z.object({
  trafficAnalytics: z.boolean(),
  apply: z.enum(["applied", "deferred", "failed", "not-in-pool", "cluster-shared"]),
  applyError: z.string().nullable(),
});

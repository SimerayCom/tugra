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
  // Extra trigger: a cleanup also runs when disk usage % reaches this (at most hourly), on top of the schedule; null clears it.
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
  project: z.string().optional(),
  environment: z.string().optional(),
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
// push API; "datadog" = Datadog logs intake (token is sent as DD-API-KEY, not a Bearer). The three NET types
// are non-HTTP transports: "syslog" (RFC 5424 over UDP/TCP/TLS), "gelf" (GELF 1.1 over UDP/TCP/TLS) and "fluentd"
// (Forward protocol over TCP/TLS); their `endpoint` is `host:port` and their per-transport `options` are required
// and validated per type in log-drains/log-drain-shape.ts. For loki/datadog the `endpoint` is that provider's URL.
export const LOG_DRAIN_TYPES = ["http", "loki", "datadog", "syslog", "gelf", "fluentd"] as const;
export const HTTP_DRAIN_TYPES = ["http", "loki", "datadog"] as const;
export const NET_DRAIN_TYPES = ["syslog", "gelf", "fluentd"] as const;
export type LogDrainType = (typeof LOG_DRAIN_TYPES)[number];

// Container filter: compose service names for an app drain, container-name globs for a server drain (the
// charset/semantics per scope are enforced in validateContainers).
const containersField = z.array(z.string().min(1).max(128)).max(32);

export const CreateLogDrainSchema = z.object({
  name: z.string().min(1),
  type: z.enum(LOG_DRAIN_TYPES).default("http"),
  endpoint: z.string().min(1).max(2048),
  token: z.string().min(1).max(4096).optional(),
  enabled: z.boolean().optional(),
  containers: containersField.optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});
export type CreateLogDrainInput = z.infer<typeof CreateLogDrainSchema>;

export const UpdateLogDrainSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(LOG_DRAIN_TYPES).optional(),
  endpoint: z.string().min(1).max(2048).optional(),
  token: z.string().min(1).max(4096).nullable().optional(),
  enabled: z.boolean().optional(),
  containers: containersField.optional(),
  options: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type UpdateLogDrainInput = z.infer<typeof UpdateLogDrainSchema>;

// App-scoped drains add the egress policy flag: `allowPrivate` lets the drain reach private/loopback ranges and
// needs servers:ops on the app's server team (an app writer alone can never point host egress at the LAN).
export const CreateAppLogDrainSchema = CreateLogDrainSchema.extend({ allowPrivate: z.boolean().optional() });
export type CreateAppLogDrainInput = z.infer<typeof CreateAppLogDrainSchema>;
export const UpdateAppLogDrainSchema = UpdateLogDrainSchema.extend({ allowPrivate: z.boolean().optional() });
export type UpdateAppLogDrainInput = z.infer<typeof UpdateAppLogDrainSchema>;

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

// ── Reboot server ────────────────────────────────────────────────────────────────────────────────────────────────────
// A reboot is never automatic. `confirmName` must equal the server's name (typed confirmation, checked in the service);
// `at` is an ISO instant (UTC or with an offset), 1 minute to 7 days ahead (checked in the service, against its clock).
export const RebootRequestSchema = z
  .object({
    mode: z.enum(["now", "scheduled"]),
    at: z.string().datetime({ offset: true }).optional(),
    confirmName: z.string().min(1).max(200),
  })
  .strict()
  .refine((b) => (b.mode === "scheduled") === (b.at !== undefined), { message: "`at` is required for a scheduled reboot and not allowed for an immediate one", path: ["at"] });
export type RebootRequestInput = z.infer<typeof RebootRequestSchema>;

const RebootStateEnum = z.enum(["SCHEDULED", "STARTING", "REBOOTING", "WAITING_AGENT", "VERIFYING", "DONE"]);
const RebootResultEnum = z.enum(["ok", "degraded", "failed", "cancelled"]);

export const RebootReportSchema = z.object({
  version: z.literal(1),
  checkedAt: z.string(),
  rebooted: z.boolean(),
  docker: z.enum(["active", "inactive", "unknown"]),
  containers: z.array(
    z.object({
      name: z.string(),
      image: z.string(),
      restartPolicy: z.string(),
      hadHealthcheck: z.boolean(),
      verdict: z.enum(["ok", "missing", "unhealthy", "pending", "skipped"]),
      detail: z.string().optional(),
    }),
  ),
  domains: z.array(z.object({ host: z.string(), verdict: z.enum(["ok", "not_answering", "not_answering_before", "pending", "unverified"]), status: z.number().nullable() })),
  domainsNote: z.enum(["skipped_no_host_port", "probe_unavailable"]).optional(),
  rebootRequired: z.enum(["cleared", "still_set", "unknown"]),
  reason: z.string().optional(),
  summary: z.object({ containersOk: z.number(), containersExpected: z.number(), domainsOk: z.number(), domainsExpected: z.number() }),
});

export const RebootViewSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  mode: z.enum(["now", "scheduled"]),
  state: RebootStateEnum,
  result: RebootResultEnum.nullable(),
  requestedBy: z.string(),
  scheduledAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  agentBackAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  createdAt: z.string(),
  /** What was expected back (counts only; the per-item results are in `report`). */
  snapshot: z.object({ containers: z.number(), domains: z.number(), hostsHub: z.boolean() }).nullable(),
  report: RebootReportSchema.nullable(),
});
export type RebootView = z.infer<typeof RebootViewSchema>;

export const RebootStatusSchema = z.object({
  /** The live reboot (scheduled or in progress), if any. */
  active: RebootViewSchema.nullable(),
  /** The most recent finished one, with its verification report. */
  last: RebootViewSchema.nullable(),
});

export const RebootPreviewSchema = z.object({
  /** Containers running now that a reboot briefly takes down. */
  containers: z.number(),
  /** Routed hostnames (RUNNING apps) that are briefly unavailable. */
  domains: z.number(),
  /** The Tugra hub itself runs on this server: the panel goes away for 1-3 minutes. */
  hostsHub: z.boolean(),
  agentOnline: z.boolean(),
});

import { z } from "zod";

export const HubHealthWarningSchema = z.object({
  code: z.enum(["heap_high", "loop_lag", "pg_connections", "redis_memory", "restarts", "queue_backlog"]),
  /** The measured value (percent for the *_high / *_connections / redis_memory codes, ms for loop_lag, a count otherwise). */
  value: z.number(),
  /** The line it crossed, same unit as value. */
  limit: z.number(),
  /** Queue name for queue_backlog. */
  detail: z.string().optional(),
});

export const HubHealthSampleSchema = z.object({
  t: z.number(),
  rssMb: z.number(),
  heapUsedMb: z.number(),
  loopP99Ms: z.number(),
});

export const HubHealthSchema = z.object({
  sampledAt: z.string(),
  healthy: z.boolean(),
  warnings: z.array(HubHealthWarningSchema),
  startedAt: z.string(),
  uptimeSec: z.number(),
  restarts: z.object({
    /** Process starts in the last 24 h, not counting the first one ever recorded (the install). From a small Redis list, so a flushed Redis resets it. */
    last24h: z.number(),
    lastBootAt: z.string().nullable(),
  }),
  process: z.object({
    rssMb: z.number(),
    heapUsedMb: z.number(),
    heapLimitMb: z.number(),
    heapPct: z.number(),
    externalMb: z.number(),
    /** Time spent in garbage collection over the last sampling window, in ms. */
    gcMs: z.number(),
  }),
  eventLoop: z.object({ p50Ms: z.number(), p99Ms: z.number(), maxMs: z.number() }),
  /** The last ~15 minutes, one point per sample, oldest first. In memory only. */
  history: z.array(HubHealthSampleSchema),
  postgres: z
    .object({
      connectionsUsed: z.number(),
      connectionsMax: z.number(),
      dbSizeBytes: z.number(),
      tables: z.array(z.object({ name: z.string(), bytes: z.number() })),
    })
    .nullable(),
  redis: z
    .object({ usedMemoryBytes: z.number(), maxMemoryBytes: z.number(), connectedClients: z.number() })
    .nullable(),
  queues: z.array(
    z.object({
      name: z.string(),
      waiting: z.number(),
      active: z.number(),
      delayed: z.number(),
      failed: z.number(),
      /** Duration of the newest completed job, null when the queue keeps none. */
      lastDurationMs: z.number().nullable(),
    }),
  ),
});

export type HubHealth = z.infer<typeof HubHealthSchema>;
export type HubHealthWarning = z.infer<typeof HubHealthWarningSchema>;

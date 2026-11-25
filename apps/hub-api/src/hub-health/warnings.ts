import type { HubHealth, HubHealthWarning } from "./dto";

/** The owner's warning lines. One place so the card, the dashboard line and the tests agree. */
export const HEAP_WARN_PCT = 80;
export const LOOP_WARN_P99_MS = 250;
export const PG_CONN_WARN_PCT = 80;
export const REDIS_MEM_WARN_PCT = 80;
export const RESTART_WARN_24H = 3;
export const QUEUE_BACKLOG_WARN = 1000;

type Inputs = Pick<HubHealth, "process" | "eventLoop" | "restarts" | "postgres" | "redis" | "queues">;

export function evaluateWarnings(h: Inputs): HubHealthWarning[] {
  const out: HubHealthWarning[] = [];
  if (h.process.heapLimitMb > 0 && h.process.heapPct >= HEAP_WARN_PCT) out.push({ code: "heap_high", value: h.process.heapPct, limit: HEAP_WARN_PCT });
  if (h.eventLoop.p99Ms >= LOOP_WARN_P99_MS) out.push({ code: "loop_lag", value: h.eventLoop.p99Ms, limit: LOOP_WARN_P99_MS });
  if (h.postgres && h.postgres.connectionsMax > 0) {
    const pct = Math.round((h.postgres.connectionsUsed / h.postgres.connectionsMax) * 100);
    if (pct >= PG_CONN_WARN_PCT) out.push({ code: "pg_connections", value: pct, limit: PG_CONN_WARN_PCT });
  }
  // Redis without a maxmemory has no ceiling to be 80% of: only a configured limit can warn.
  if (h.redis && h.redis.maxMemoryBytes > 0) {
    const pct = Math.round((h.redis.usedMemoryBytes / h.redis.maxMemoryBytes) * 100);
    if (pct >= REDIS_MEM_WARN_PCT) out.push({ code: "redis_memory", value: pct, limit: REDIS_MEM_WARN_PCT });
  }
  if (h.restarts.last24h >= RESTART_WARN_24H) out.push({ code: "restarts", value: h.restarts.last24h, limit: RESTART_WARN_24H });
  for (const q of h.queues) if (q.waiting >= QUEUE_BACKLOG_WARN) out.push({ code: "queue_backlog", value: q.waiting, limit: QUEUE_BACKLOG_WARN, detail: q.name });
  return out;
}

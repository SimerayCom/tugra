import type { SourceHealth, SourceHealthRow } from "../import-source";

/**
 * Pure mappers for the Coolify health baseline (P7 PREFLIGHT): the `status` string of an app/database/service
 * (`running:healthy`, `running:unknown`, `exited:unhealthy`, `restarting:unhealthy`, ...) and the container `restart_count`
 * counter. Both ride the same list rows discover() already reads, so the baseline needs no extra permission. Secret-free:
 * refs, an enum and a number leave this file.
 */

/** A row of `GET /applications`, `/databases` or `/services` (only the fields the baseline reads). */
export interface CoolifyHealthRow {
  uuid?: unknown;
  status?: unknown;
  restart_count?: unknown;
}

const DOWN_STATES = new Set(["exited", "stopped", "dead", "removing", "created", "paused", "failed"]);

/**
 * `state[:health]` to the baseline enum. `running:healthy` is healthy; any `unhealthy` health, a `restarting`/`degraded` state
 * is unhealthy; a stopped state is `exited`; `running:unknown` (no health check) and anything unreadable is `unknown`, which
 * is a truthful "nobody checked", not a pass.
 */
export function coolifyHealth(status: unknown): SourceHealth {
  if (typeof status !== "string") return "unknown";
  const [state, health = ""] = status.trim().toLowerCase().split(":", 2);
  if (DOWN_STATES.has(state)) return "exited";
  if (health === "unhealthy" || state === "restarting" || state === "degraded") return "unhealthy";
  if (state === "running" && health === "healthy") return "healthy";
  return "unknown";
}

/** A restart counter as a non-negative integer, else null (a missing or garbled value is "unknown", never 0). */
export function coolifyRestartCount(v: unknown): number | null {
  const n = typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** The baseline rows of one resource kind. `serverOf` maps a uuid to the source server it runs on (from `/servers/{uuid}/resources`). */
export function coolifyHealthRows(kind: SourceHealthRow["kind"], rows: readonly CoolifyHealthRow[], serverOf: ReadonlyMap<string, string>): SourceHealthRow[] {
  const out: SourceHealthRow[] = [];
  for (const r of rows) {
    if (typeof r?.uuid !== "string" || !r.uuid) continue;
    const serverRef = serverOf.get(r.uuid);
    out.push({ kind, ref: r.uuid, ...(serverRef ? { serverRef } : {}), health: coolifyHealth(r.status), restartCount: coolifyRestartCount(r.restart_count) });
  }
  return out;
}

/** What `GET /version` returned, as a token: plain text (`4.1.2`), a JSON string (`"4.1.2"`) or `v4.1.2`. null when it is not one. */
export function coolifyVersionToken(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const t = body.trim().replace(/^"(.*)"$/s, "$1").trim();
  return /^v?\d{1,6}(\.\d{1,6}){1,2}([-+][0-9A-Za-z.+-]{0,40})?$/.test(t) ? t : null;
}

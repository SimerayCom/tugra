/**
 * Typed notification events + a template registry (Dilim 3). Firing sites produce a typed
 * `NotificationEvent` (an id + a plain-object `ctx`); `renderEvent` picks a per-event template that
 * builds a rich `RenderedMessage`. This replaces the D2 `plainToRendered` shim. Templates are PURE
 * (no DI): the web base URL for deep-links AND a locale-bound translator `t` are threaded in via
 * `RenderEnv`. Every user-facing string comes from `t(key, params)` (Dilim 5 server-side i18n).
 */
import type { MsgField, MsgLevel, RenderedMessage } from "./rendered-message";
import { deployTemplate } from "./templates/deploy";
import { backupFailedTemplate, backupSucceededTemplate, restoreFailedTemplate } from "./templates/backup";
import { serverOfflineTemplate, serverOnlineTemplate } from "./templates/server";
import { swarmDegradedTemplate } from "./templates/swarm";
import { sslExpiringTemplate, tokenExpiringTemplate } from "./templates/expiry";
import { monitorTemplate } from "./templates/monitor";
import { volumeBackupTemplate } from "./templates/volume-backup";
import { scheduledTaskTemplate } from "./templates/scheduled-task";
import { dockerCleanupTemplate } from "./templates/docker-cleanup";
import { genericTemplate, testTemplate } from "./templates/generic";

/** A locale-bound translator: resolves a dotted key with `{param}` interpolation (NotifI18nService). */
export type NotifI18n = (key: string, params?: Record<string, string | number>) => string;

export interface NotificationEvent {
  type: string;
  teamId: string;
  locale?: string; // the channel's language; picks the catalog for `t`
  ctx: Record<string, unknown>;
}
export interface RenderEnv {
  webBaseUrl: string;
  t: NotifI18n;
}
export interface EventTemplate {
  render(ev: NotificationEvent, env: RenderEnv): RenderedMessage;
}

// ---- defensive ctx readers (never emit the string "undefined") ----

/** Read a ctx field as a string; missing/null → "" (so a template never renders "undefined"). */
export function s(ctx: Record<string, unknown>, k: string): string {
  const v = ctx[k];
  return v == null ? "" : String(v);
}

/** Read a ctx field as a finite number; missing/NaN → 0. */
export function num(ctx: Record<string, unknown>, k: string): number {
  const n = Number(ctx[k]);
  return Number.isFinite(n) ? n : 0;
}

/** Cap a value so it fits provider limits (Discord embed field ≤ 1024); appends an ellipsis. */
export function clamp(v: string, max = 1000): string {
  return v.length <= max ? v : v.slice(0, max - 1) + "…";
}

/** Build a field list, DROPPING any whose value is empty and adding `inline` only when true. */
export function fields(entries: Array<{ label: string; value: string; inline?: boolean }>): MsgField[] {
  return entries
    .filter((e) => e.value !== "")
    .map((e) => (e.inline ? { label: e.label, value: e.value, inline: true } : { label: e.label, value: e.value }));
}

const LEVELS: ReadonlySet<string> = new Set(["success", "failure", "warning", "info"]);
/** Coerce an arbitrary string to a MsgLevel, falling back for unknown values (generic template). */
export function asLevel(v: string, fallback: MsgLevel = "info"): MsgLevel {
  return (LEVELS.has(v) ? v : fallback) as MsgLevel;
}

/** Human duration: "" for ≤0, "42s" under a minute, else "3m 20s". */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return "";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Human byte size ("1.5 GB" / "820 MB" / "12 KB" / "512 B"); ≤0 or non-finite → "" so fields() drops it.
 *  Mirrors `web/lib/fleet.ts:fmtBytes` (same thresholds/precision) with a guard for the empty case. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(0)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
  return `${n} B`;
}

/** Format an ISO timestamp as "YYYY-MM-DD HH:mm UTC"; invalid/empty → "". */
export function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** Fill the boilerplate (timestamp + event id) so templates carry only semantic fields. */
export function base(ev: NotificationEvent, m: Omit<RenderedMessage, "timestamp" | "event">): RenderedMessage {
  return { ...m, timestamp: new Date().toISOString(), event: ev.type };
}

const REGISTRY: Record<string, EventTemplate> = {
  deploy_success: deployTemplate,
  deploy_failed: deployTemplate,
  deploy_rolled_back: deployTemplate,
  backup_failed: backupFailedTemplate,
  backup_success: backupSucceededTemplate,
  backup_restore_failed: restoreFailedTemplate,
  ssl_expiring: sslExpiringTemplate,
  token_expiring: tokenExpiringTemplate,
  server_offline: serverOfflineTemplate,
  server_online: serverOnlineTemplate,
  swarm_degraded: swarmDegradedTemplate,
  volume_backup_success: volumeBackupTemplate,
  volume_backup_failed: volumeBackupTemplate,
  scheduled_task_success: scheduledTaskTemplate,
  scheduled_task_failed: scheduledTaskTemplate,
  docker_cleanup_success: dockerCleanupTemplate,
  docker_cleanup_failed: dockerCleanupTemplate,
  monitor_up: monitorTemplate,
  monitor_down: monitorTemplate,
  test: testTemplate,
};

/** Select a template by event id (unknown ids → generic) and render the typed event. */
export function renderEvent(ev: NotificationEvent, env: RenderEnv): RenderedMessage {
  return (REGISTRY[ev.type] ?? genericTemplate).render(ev, env);
}

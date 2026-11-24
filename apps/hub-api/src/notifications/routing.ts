/**
 * Notification routing — which channel gets which event, and (Telegram) into which forum topic.
 * Pure helpers (no DI): an event maps to a category (shared `EVENT_CATEGORY`) and a severity tier
 * (derived from the level the event's own template renders), and a channel rule selects categories
 * plus a minimum severity. A channel with no rule behaves exactly as before: `eventTypes` alone decides.
 */
import {
  categoryOfEvent,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_SEVERITIES,
  type NotificationCategory,
  type NotificationSeverity,
} from "@tugra/shared";
import { renderEvent, type NotificationEvent } from "./event";
import type { MsgLevel } from "./rendered-message";

/** The routing-relevant slice of a stored channel; every field is optional so legacy rows read as "no rule". */
export interface ChannelRule {
  eventTypes?: string[] | null;
  categories?: string[] | null;
  minSeverity?: string | null;
  topics?: unknown;
}

const SEVERITY_RANK: Record<string, number> = Object.fromEntries(NOTIFICATION_SEVERITIES.map((s, i) => [s, i]));

export function isCategory(v: unknown): v is NotificationCategory {
  return typeof v === "string" && (NOTIFICATION_CATEGORIES as readonly string[]).includes(v);
}

/** Message level → severity tier. Successes and infos are routine ("info"); failures are "critical". */
export function severityOfLevel(level: MsgLevel): NotificationSeverity {
  if (level === "failure") return "critical";
  if (level === "warning") return "warning";
  return "info";
}

/**
 * The severity of an event, from the level its template actually renders (so it can never drift from
 * what the channel will show). Level is locale-independent, hence the identity translator. Fails open to
 * "critical": if a template throws we would rather over-notify than drop an alert.
 */
export function eventSeverity(ev: NotificationEvent): NotificationSeverity {
  try {
    return severityOfLevel(renderEvent(ev, { webBaseUrl: "", t: (k) => k }).level);
  } catch {
    return "critical";
  }
}

/** Category of a notification: the registry's, or (for the per-category "test") the one named in ctx. */
export function categoryOfNotification(ev: Pick<NotificationEvent, "type" | "ctx">): NotificationCategory | undefined {
  const known = categoryOfEvent(ev.type);
  if (known) return known;
  return ev.type === "test" && isCategory(ev.ctx.category) ? ev.ctx.category : undefined;
}

function meetsSeverity(rule: ChannelRule, severity: NotificationSeverity): boolean {
  const min = SEVERITY_RANK[rule.minSeverity ?? "info"] ?? 0;
  return (SEVERITY_RANK[severity] ?? 0) >= min;
}

/**
 * Should a channel receive a general (non-monitor) event? Subscribed when the event id is in
 * `eventTypes` OR its category is in `categories`, AND the event is at least `minSeverity`.
 */
export function channelWantsEvent(rule: ChannelRule, eventType: string, severity: NotificationSeverity): boolean {
  const category = categoryOfEvent(eventType);
  const subscribed =
    (rule.eventTypes ?? []).includes(eventType) || (category !== undefined && (rule.categories ?? []).includes(category));
  return subscribed && meetsSeverity(rule, severity);
}

/**
 * Should a channel LINKED to a monitor receive its up/down alert? The monitor↔channel link is the
 * recipient list (unchanged), so an empty `categories` (legacy) lets everything through; once categories
 * are set, "uptime" must be one of them. The severity floor applies either way.
 */
export function channelWantsMonitorEvent(rule: ChannelRule, severity: NotificationSeverity): boolean {
  const cats = rule.categories ?? [];
  return (cats.length === 0 || cats.includes("uptime")) && meetsSeverity(rule, severity);
}

/** Telegram forum topic (message_thread_id) mapped to a category, or undefined. Ignores malformed JSON. */
export function topicFor(topics: unknown, category: NotificationCategory | undefined): number | undefined {
  if (!category || !topics || typeof topics !== "object") return undefined;
  const v = (topics as Record<string, unknown>)[category];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/**
 * The config a provider should send with: for Telegram, a category topic overrides the channel's
 * default `messageThreadId`; categories without a topic keep the default. Other types pass through.
 */
export function routedConfig(
  type: string,
  config: Record<string, unknown>,
  topics: unknown,
  ev: Pick<NotificationEvent, "type" | "ctx">,
): Record<string, unknown> {
  if (type !== "telegram") return config;
  const topic = topicFor(topics, categoryOfNotification(ev));
  return topic === undefined ? config : { ...config, messageThreadId: topic };
}

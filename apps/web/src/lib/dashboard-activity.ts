import type { AuditEntry } from "./types";

/** Audit actions that are the product doing its own housekeeping or a user merely reading something. They stay in
 *  the audit log; the dashboard summary folds them away unless "Show system events" is on. */
const QUIET_ACTIONS = new Set([
  "server.gpus.refresh",
  "server.patch.check",
  "server.patch.check.bulk",
  "server.container.logs.stream",
  "server.container.logs.download",
  "app.logs.stream",
  "app.logs.download",
  "database.logs.stream",
  "database.logs.download",
  "app.file.download",
  "app.image_update_check.run",
  "app.deploy.analyze",
  "app.compose.preview",
  "terminal.open",
  "auth.profile.update",
  "auth.login",
  "auth.logout",
  "auth.logout_all",
  "auth.email.verify.sent",
  "auth.email.verified",
]);

export type QuietGroup = "mcp" | "system";

/** null = a normal event that always shows. */
export function quietGroup(action: string): QuietGroup | null {
  if (action.startsWith("mcp.")) return "mcp";
  return QUIET_ACTIONS.has(action) ? "system" : null;
}

export type ActivityLine =
  | { kind: "event"; entry: AuditEntry }
  | { kind: "group"; group: QuietGroup; count: number; latest: string };

/**
 * Turn the newest audit entries into at most `limit` dashboard lines. Normal events keep their place in time order;
 * with `showSystem` off, every quiet event of one group collapses into ONE line (at the position of its newest
 * member) carrying a count, so a burst of 40 MCP reads costs one row, not the whole card.
 */
export function summarizeActivity(entries: AuditEntry[], showSystem: boolean, limit: number): { lines: ActivityLine[]; quietCount: number } {
  const quietCount = entries.filter((e) => quietGroup(e.action) !== null).length;
  if (showSystem) return { lines: entries.slice(0, limit).map((entry) => ({ kind: "event" as const, entry })), quietCount };
  const lines: ActivityLine[] = [];
  const groups = new Map<QuietGroup, Extract<ActivityLine, { kind: "group" }>>();
  for (const entry of entries) {
    const g = quietGroup(entry.action);
    if (g === null) {
      lines.push({ kind: "event", entry });
    } else if (!groups.has(g)) {
      const line = { kind: "group" as const, group: g, count: 1, latest: entry.createdAt };
      groups.set(g, line);
      lines.push(line);
    } else {
      groups.get(g)!.count += 1;
    }
  }
  return { lines: lines.slice(0, limit), quietCount };
}

/** i18n key of the sentence for an action (`server.proxy.restart` → `dashboard.event.server_proxy_restart`). */
export const eventKey = (action: string) => `dashboard.event.${action.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;

/** A readable object name from the audit meta when the writer recorded one (never a raw id). */
export function eventSubject(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "";
  const m = meta as Record<string, unknown>;
  for (const k of ["name", "domain", "email", "project", "title"]) {
    const v = m[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 60);
  }
  return "";
}

/**
 * The sentence for one entry. `t` resolves the sentence template (returns the key itself when there is none, which
 * falls back to the generic "actor: action" form so an unknown action is never blank).
 */
export function humanizeEvent(
  entry: AuditEntry,
  t: (key: string, vars?: Record<string, string | number>) => string,
  me: string | null | undefined,
): string {
  const actor = me && entry.actor.toLowerCase() === me.toLowerCase() ? t("dashboard.eventYou") : entry.actor;
  const subject = eventSubject(entry.meta);
  const key = eventKey(entry.action);
  const sentence = t(key, { actor, subject: subject || t("dashboard.eventSomething") });
  if (sentence !== key) return sentence;
  return t("dashboard.eventGeneric", { actor, action: entry.action.replace(/[._]+/g, " ") });
}

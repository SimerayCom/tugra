import type { StatusOverall, StatusMonitorState } from "./types";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** A suggested address from a team name: lowercase letters, digits and single dashes (3 to 40 characters). */
export function suggestSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/ı/g, "i") // dotless i has no decomposition
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : `${base || "status"}-page`.slice(0, 40);
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function validSlug(slug: string): boolean {
  return slug.length >= 3 && slug.length <= 40 && SLUG_RE.test(slug);
}

/** "12 min", "3 h", "2 d" for an incident's length. */
export function incidentDuration(startedAt: string, resolvedAt: string, t: T): string {
  const ms = Math.max(0, new Date(resolvedAt).getTime() - new Date(startedAt).getTime());
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return t("statusPage.durationMinutes", { n: min });
  const h = Math.round(min / 60);
  if (h < 48) return t("statusPage.durationHours", { n: h });
  return t("statusPage.durationDays", { n: Math.round(h / 24) });
}

export function overallTone(s: StatusOverall): "ok" | "warn" | "danger" | "muted" {
  if (s === "operational") return "ok";
  if (s === "outage") return "danger";
  if (s === "partial" || s === "maintenance") return "warn";
  return "muted";
}

export function monitorTone(s: StatusMonitorState): "ok" | "warn" | "danger" | "muted" {
  if (s === "up") return "ok";
  if (s === "down") return "danger";
  if (s === "checking") return "warn";
  return "muted";
}

/** Colour variable of a day bar: green when (nearly) all checks passed, amber below 99.9, red below 99, grey = no data. */
export function dayColor(uptime: number | null): string {
  if (uptime === null) return "var(--c-bd)";
  if (uptime >= 99.9) return "var(--c-g)";
  if (uptime >= 99) return "var(--c-am)";
  return "var(--c-r)";
}

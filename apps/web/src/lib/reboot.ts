import type { RebootReport, RebootState, RebootView } from "./types";

/** The limits the hub enforces on a scheduled reboot (kept here so the form can say so before the round trip). */
export const REBOOT_MIN_LEAD_MS = 60_000;
export const REBOOT_MAX_LEAD_MS = 7 * 24 * 60 * 60_000;

/** How often the card re-reads a live reboot. */
export const rebootPollMs = { live: 4000 };

/** The steps a reboot walks through, in order, as the card draws them. `SCHEDULED` is only shown for a scheduled one. */
export type RebootPhase = "scheduled" | "rebooting" | "waiting" | "verifying";

/** Which phase a live reboot is in. STARTING (the snapshot + arming, a few seconds) reads as "rebooting". null = not live. */
export function rebootPhase(state: RebootState | undefined): RebootPhase | null {
  switch (state) {
    case "SCHEDULED":
      return "scheduled";
    case "STARTING":
    case "REBOOTING":
      return "rebooting";
    case "WAITING_AGENT":
      return "waiting";
    case "VERIFYING":
      return "verifying";
    default:
      return null;
  }
}

/** The phases to draw for this reboot (a reboot started now has no "scheduled" step). */
export function rebootSteps(r: Pick<RebootView, "mode">): RebootPhase[] {
  return r.mode === "scheduled" ? ["scheduled", "rebooting", "waiting", "verifying"] : ["rebooting", "waiting", "verifying"];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The value an `<input type="datetime-local">` takes for this instant, in the BROWSER's local time. */
export function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value (local time, no offset) -> the ISO UTC instant it names; null when it is not a date. */
export function fromLocalInputValue(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** A sensible default for the picker: an hour from now, on the next 5-minute mark. */
export function defaultScheduleValue(nowMs: number): string {
  const step = 5 * 60_000;
  return toLocalInputValue(new Date(Math.ceil((nowMs + 60 * 60_000) / step) * step));
}

export type ScheduleProblem = "invalid" | "past" | "tooFar";

/** Is this picker value an acceptable schedule? Mirrors the hub's rule (a minute to 7 days ahead). null = fine. */
export function scheduleProblem(localValue: string, nowMs: number): ScheduleProblem | null {
  const iso = fromLocalInputValue(localValue);
  if (!iso) return "invalid";
  const t = new Date(iso).getTime();
  if (t < nowMs + REBOOT_MIN_LEAD_MS) return "past";
  if (t > nowMs + REBOOT_MAX_LEAD_MS) return "tooFar";
  return null;
}

/** "2026-11-27 12:30 UTC" — the instant as the hub stores it. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The instant in the viewer's own time zone. */
export function formatLocal(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/** Everything in a report that did not come back as it should: names only, for a short summary line. */
export function reportProblems(report: RebootReport): { containers: string[]; domains: string[] } {
  return {
    containers: report.containers.filter((c) => c.verdict === "missing" || c.verdict === "unhealthy" || c.verdict === "pending").map((c) => c.name),
    domains: report.domains.filter((d) => d.verdict === "not_answering" || d.verdict === "pending").map((d) => d.host),
  };
}

/** Should the typed confirmation unlock the button? Exactly the server's name, nothing else. */
export function confirmationMatches(typed: string, serverName: string): boolean {
  return serverName.length > 0 && typed === serverName;
}

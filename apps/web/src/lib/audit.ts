import type { AuditEntry } from "./types";

/** Free-text filter over actor / action / target (case-insensitive). */
export function filterAudit(entries: AuditEntry[], q: string): AuditEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((e) =>
    `${e.actor} ${e.action} ${e.target ?? ""}`.toLowerCase().includes(needle),
  );
}

function csvCell(v: string): string {
  // RFC-4180-ish: quote when the value has a comma, quote, or newline; escape quotes.
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Serialize audit rows to a CSV string (header + one row per entry). */
export function auditToCsv(entries: AuditEntry[]): string {
  const header = ["Time", "Actor", "Action", "Target"];
  const rows = entries.map((e) =>
    [e.createdAt, e.actor, e.action, e.target ?? ""].map(csvCell).join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

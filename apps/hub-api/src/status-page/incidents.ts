/**
 * Incident history for the public status page, derived purely from a monitor's state changes. The monitor runner
 * flags a heartbeat `important` on the UP<->DOWN edges (first DOWN, recovery) and on every resend of a long DOWN, so a
 * stream of important beats folds into incidents: a DOWN opens one (re-sent DOWNs are ignored), the next UP closes it.
 */
export interface Beat {
  monitorId: string;
  status: "UP" | "DOWN" | "PENDING";
  important: boolean;
  ts: Date;
}

export interface Incident {
  monitorId: string;
  startedAt: Date;
  /** null while the monitor is still down. */
  resolvedAt: Date | null;
}

/** Fold important beats (any order, any mix of monitors) into incidents, newest first. A recovery with no opening
 *  DOWN in the window (the incident started before it) is ignored. */
export function deriveIncidents(beats: Beat[]): Incident[] {
  const sorted = beats.filter((b) => b.important).sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const open = new Map<string, Incident>();
  const out: Incident[] = [];
  for (const b of sorted) {
    const cur = open.get(b.monitorId);
    if (b.status === "DOWN" && !cur) {
      const inc: Incident = { monitorId: b.monitorId, startedAt: b.ts, resolvedAt: null };
      open.set(b.monitorId, inc);
      out.push(inc);
    } else if (b.status === "UP" && cur) {
      cur.resolvedAt = b.ts;
      open.delete(b.monitorId);
    }
  }
  return out.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

/** An incident still open although its monitor is no longer DOWN (a missed recovery beat, a pruned row) is closed at
 *  `now` instead of showing a phantom outage forever. */
export function settleIncidents(incidents: Incident[], currentStatus: Map<string, string>, now: Date): Incident[] {
  return incidents.map((i) => (i.resolvedAt === null && currentStatus.get(i.monitorId) !== "DOWN" ? { ...i, resolvedAt: now } : i));
}

export type OverallStatus = "operational" | "partial" | "outage" | "maintenance" | "unknown";
export type PublicMonitorStatus = "up" | "down" | "checking" | "paused";

/** The page-level banner from the monitors' states and whether a maintenance window is running right now. */
export function overallStatus(states: PublicMonitorStatus[], maintenanceActive: boolean): OverallStatus {
  if (maintenanceActive) return "maintenance";
  const live = states.filter((s) => s !== "paused");
  if (live.length === 0) return "unknown";
  const down = live.filter((s) => s === "down").length;
  if (down === 0) return "operational";
  return down === live.length ? "outage" : "partial";
}

export type MaintenanceState = "scheduled" | "active" | "completed";

export function maintenanceState(m: { startsAt: Date; endsAt: Date }, now: Date): MaintenanceState {
  if (now < m.startsAt) return "scheduled";
  return now < m.endsAt ? "active" : "completed";
}

/** Uptime percentage over day buckets (null when nothing was measured). Two decimals, like the monitor uptime. */
export function uptimeOver(days: { up: number; total: number }[]): number | null {
  const total = days.reduce((n, d) => n + d.total, 0);
  if (total === 0) return null;
  const up = days.reduce((n, d) => n + d.up, 0);
  return Math.round((up / total) * 10000) / 100;
}

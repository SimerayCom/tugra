import type { ProjectMoveCheck, ProjectMoveDnsStep, ProjectMoveReport } from "@tugra/shared";

/**
 * The verification report of a finished project move (lane H), pure. One check per fact the owner would otherwise have to go and look at.
 * `ok: false` on any check keeps the move from "completed": it ends FAILED and says which.
 */

export interface ReportApp {
  id: string;
  name: string;
  serverId: string;
  status: string;
  wasRunning: boolean;
  hostnames: string[];
}
export interface ReportDb {
  sourceId: string;
  name: string;
  configOnly: boolean;
  /** The copy (or, for a config-only move, the same row). */
  target: { status: string; serverId: string } | null;
  restoreOk: boolean;
  /** Every link the move removed from an app is back, on the copy. */
  relinked: boolean;
  /** The source database after the move (null when it is the same row). */
  source: { status: string } | null;
  setAside: boolean;
}

export interface ReportFacts {
  targetServerId: string;
  targetIp: string | null;
  apps: ReportApp[];
  dbs: ReportDb[];
  repointDns: boolean;
  retainDays: number;
  warnings: string[];
}

export function buildReport(f: ReportFacts): ProjectMoveReport {
  const checks: ProjectMoveCheck[] = [];
  const add = (code: ProjectMoveCheck["code"], itemRef: string, name: string, ok: boolean) => checks.push({ code, itemRef, name, ok });

  for (const a of f.apps) add("app_running", a.id, a.name, a.serverId === f.targetServerId && (!a.wasRunning || a.status === "RUNNING"));
  for (const d of f.dbs) {
    // A database that was never deployed has nothing running to check: it only has to sit on the target.
    const up = d.target !== null && (d.configOnly ? d.target.status === "NEW" || d.target.status === "RUNNING" : d.target.status === "RUNNING");
    add("db_running", d.sourceId, d.name, d.target?.serverId === f.targetServerId && up);
    if (!d.configOnly) {
      add("db_restored", d.sourceId, d.name, d.restoreOk);
      add("db_relinked", d.sourceId, d.name, d.relinked);
      add("source_stopped", d.sourceId, d.name, d.source?.status === "STOPPED");
      if (f.retainDays > 0) add("safety_copy_kept", d.sourceId, d.name, d.setAside && d.source !== null);
    }
  }

  const seen = new Set<string>();
  const dns: ProjectMoveDnsStep[] = [];
  for (const a of f.apps) {
    for (const h of a.hostnames) {
      const host = h.trim().toLowerCase();
      if (!host || seen.has(host)) continue;
      seen.add(host);
      dns.push({ hostname: host, targetIp: f.targetIp, repointed: f.repointDns });
    }
  }
  return { checks, dns, warnings: f.warnings };
}

export const reportOk = (r: ProjectMoveReport): boolean => r.checks.every((c) => c.ok);

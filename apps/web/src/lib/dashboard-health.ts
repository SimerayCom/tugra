import type { DomainView, Monitor, ServerView, MigrationRunSummary } from "./types";

export const CERT_WARN_DAYS = 30;

export interface CertRow {
  appId: string;
  domain: string;
  daysRemaining: number | null;
  state: "ok" | "expiring" | "error" | "none";
}

/** Certificates that need a look, soonest first: errors, then expiring ones by days left. Domains that are not
 *  meant to serve TLS (https off, state "none") are skipped, exactly as the Needs-attention list does. */
export function certsExpiringSoon(domains: DomainView[], warnDays = CERT_WARN_DAYS): CertRow[] {
  return domains
    .filter((d) => d.https !== false && (d.ssl.state === "error" || d.ssl.state === "expiring" || (d.ssl.state === "ok" && d.ssl.daysRemaining !== null && d.ssl.daysRemaining <= warnDays)))
    .map((d) => ({ appId: d.appId, domain: d.domain, daysRemaining: d.ssl.daysRemaining, state: d.ssl.state }))
    .sort((a, b) => (a.state === "error" ? -1 : 0) - (b.state === "error" ? -1 : 0) || (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity));
}

/** Numeric dotted version compare on the leading `x.y.z`; a pre-release suffix (`-beta.27`) is compared by its
 *  trailing number. >0 when a is newer. Unparseable input compares equal (never claims an update). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.?(\d+))?/i.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

/** Online servers whose agent is older than the hub they report to. */
export function outdatedAgents(servers: ServerView[], hubVersion: string | null | undefined): ServerView[] {
  if (!hubVersion) return [];
  return servers.filter((s) => s.status !== "PENDING" && !!s.agentVersion && compareVersions(hubVersion, s.agentVersion) > 0);
}

export interface UptimeSummary {
  monitorsUp: number;
  monitorsDown: number;
  monitorsTotal: number;
  serversOnline: number;
  serversTotal: number;
  /** Longest continuous uptime among the online servers, seconds (null = none reported). */
  longestUptimeSec: number | null;
}

export function uptimeSummary(servers: ServerView[], monitors: Monitor[]): UptimeSummary {
  const active = monitors.filter((m) => m.enabled);
  const online = servers.filter((s) => s.status === "ONLINE");
  const ups = online.map((s) => s.uptimeSeconds).filter((n): n is number => typeof n === "number" && n >= 0);
  return {
    monitorsUp: active.filter((m) => m.status === "UP").length,
    monitorsDown: active.filter((m) => m.status === "DOWN").length,
    monitorsTotal: active.length,
    serversOnline: online.length,
    serversTotal: servers.length,
    longestUptimeSec: ups.length ? Math.max(...ups) : null,
  };
}

const LIVE_MIGRATION = new Set(["QUEUED", "RUNNING", "WAITING", "PAUSED", "ABORTING", "ROLLING_BACK", "REVERSING"]);

/** Migration runs worth showing: every live one, plus the newest finished or failed one. */
export function migrationDigest(runs: MigrationRunSummary[]): { live: MigrationRunSummary[]; lastDone: MigrationRunSummary | null; failed: MigrationRunSummary[] } {
  const byNewest = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    live: byNewest.filter((r) => LIVE_MIGRATION.has(r.status) && !r.dryRun),
    failed: byNewest.filter((r) => r.status === "FAILED" && !r.dryRun),
    lastDone: byNewest.find((r) => r.status === "COMPLETED" && !r.dryRun) ?? null,
  };
}

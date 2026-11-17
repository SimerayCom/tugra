/**
 * Pure logic of the reboot feature: what a snapshot holds, how a verification read is judged, how a schedule is
 * validated. No I/O, no clock reads (callers pass `now`), so every branch is unit-tested directly.
 */
import { isProbeableTarget, MAX_PROBE_DOMAINS, type DomainProbeRead, type DomainTarget, type RebootStateRead } from "./reboot-script";

export const REBOOT_STATES = ["SCHEDULED", "STARTING", "REBOOTING", "WAITING_AGENT", "VERIFYING", "DONE"] as const;
export type RebootState = (typeof REBOOT_STATES)[number];
export const REBOOT_RESULTS = ["ok", "degraded", "failed", "cancelled"] as const;
export type RebootResult = (typeof REBOOT_RESULTS)[number];
export type RebootMode = "now" | "scheduled";

/** Live (not DONE) states: a server has at most one reboot in any of them. */
export const ACTIVE_REBOOT_STATES: RebootState[] = ["SCHEDULED", "STARTING", "REBOOTING", "WAITING_AGENT", "VERIFYING"];

/** Timings of the lifecycle. A mutable object so tests can shrink them. */
export const rebootTiming = {
  /** How often the watcher looks at every live reboot. */
  tickMs: 10_000,
  /** A scheduled reboot waits this long for a busy server (patch/deploy running) before it gives up. */
  busyRetryWindowMs: 30 * 60_000,
  /** STARTING rows older than this were abandoned by a hub that died mid-start. */
  startingStaleMs: 3 * 60_000,
  /** After the reboot unit was created, the host is still on the SAME boot this long -> the reboot did not happen. */
  noRebootGraceMs: 4 * 60_000,
  /** The agent has this long after the unit was created to come back on a new boot. */
  agentDeadlineMs: 20 * 60_000,
  /** Verification polls for at most this long after the agent is back. */
  verifyWindowMs: 10 * 60_000,
  /** The earliest a scheduled reboot may be, from now. */
  minLeadMs: 60_000,
  /** The furthest a scheduled reboot may be, from now. */
  maxLeadMs: 7 * 24 * 60 * 60_000,
};

// ── schedule validation ────────────────────────────────────────────────────────────────────────────────────────────

export type ScheduleCheck = { ok: true; at: Date } | { ok: false; reason: "invalid" | "past" | "too_far" };

/** `at` must be a real instant, at least a minute away and at most 7 days away. */
export function checkRebootSchedule(at: string | undefined, now: number): ScheduleCheck {
  const t = at ? new Date(at).getTime() : NaN;
  if (!Number.isFinite(t)) return { ok: false, reason: "invalid" };
  if (t < now + rebootTiming.minLeadMs) return { ok: false, reason: "past" };
  if (t > now + rebootTiming.maxLeadMs) return { ok: false, reason: "too_far" };
  return { ok: true, at: new Date(t) };
}

// ── snapshot ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SnapshotContainer {
  name: string;
  image: string;
  restartPolicy: string;
  /** "none" when the container has no healthcheck. */
  health: string;
  swarm: boolean;
}

export interface RebootSnapshot {
  version: 1;
  takenAt: string;
  /** The kernel boot id before the reboot: a different one afterwards proves the host really rebooted. */
  bootId: string;
  /** This server also runs the Tugra hub (the panel goes away while it reboots). */
  hostsHub: boolean;
  containers: SnapshotContainer[];
  domains: DomainTarget[];
  /** loopback: probe the proxy on 127.0.0.1; skipped_no_host_port: the proxy publishes no host port, so it cannot be probed. */
  probe: "loopback" | "skipped_no_host_port";
}

/** The running containers of a state read, as the snapshot keeps them. Only RUNNING ones are expected back. */
export function snapshotContainers(read: RebootStateRead): SnapshotContainer[] {
  return read.containers
    .filter((c) => c.state === "running")
    .map((c) => ({ name: c.name, image: c.image, restartPolicy: c.restartPolicy, health: c.health, swarm: c.swarm }));
}

/** Does this container come back by itself after a reboot? (A restart policy other than "no"; swarm tasks are
 *  rescheduled under new names, so they are not tracked by name.) */
export function isExpectedBack(c: SnapshotContainer): boolean {
  return !c.swarm && c.restartPolicy !== "no" && c.restartPolicy !== "";
}

export interface AppRoutingRow {
  status: string;
  domain: string | null;
  https: boolean;
  extraDomains: string[];
  pathPrefix: string | null;
  serviceDomains: { hostname: string }[];
}

/** The hostnames the server's proxy routes for apps that should be up. RUNNING apps only; deduped by host; invalid or
 *  oversized entries dropped. A host is probed on the app's primary scheme; alias and per-service hosts are always https
 *  (their routers sit on websecure). */
export function buildDomainTargets(apps: AppRoutingRow[]): DomainTarget[] {
  const out = new Map<string, DomainTarget>();
  const add = (host: string | null | undefined, scheme: "http" | "https", path: string) => {
    if (!host) return;
    const h = host.trim().toLowerCase();
    if (out.has(h)) return;
    const t: DomainTarget = { host: h, scheme, path };
    if (isProbeableTarget(t)) out.set(h, t);
  };
  for (const a of apps) {
    if (a.status !== "RUNNING") continue;
    const prefix = a.pathPrefix ? (a.pathPrefix.startsWith("/") ? a.pathPrefix : `/${a.pathPrefix}`) : "";
    add(a.domain, a.https ? "https" : "http", prefix || "/");
    for (const h of a.extraDomains) add(h, "https", "/");
    for (const s of a.serviceDomains) add(s.hostname, "https", "/");
  }
  return [...out.values()].slice(0, MAX_PROBE_DOMAINS);
}

// ── verification ───────────────────────────────────────────────────────────────────────────────────────────────────

export type ContainerVerdict = "ok" | "missing" | "unhealthy" | "pending" | "skipped";
export type DomainVerdict = "ok" | "not_answering" | "pending" | "unverified";

export interface ContainerReportRow {
  name: string;
  image: string;
  restartPolicy: string;
  hadHealthcheck: boolean;
  verdict: ContainerVerdict;
  /** What the container looks like now (docker state / health), for the human reading the report. */
  detail?: string;
}

export interface DomainReportRow {
  host: string;
  verdict: DomainVerdict;
  /** The HTTP status the proxy answered with; null when it did not answer or was not probed. */
  status: number | null;
}

export type RebootFlagVerdict = "cleared" | "still_set" | "unknown";

export interface RebootReport {
  version: 1;
  checkedAt: string;
  /** The boot id differs from the snapshot's (the host really rebooted). */
  rebooted: boolean;
  docker: "active" | "inactive" | "unknown";
  containers: ContainerReportRow[];
  domains: DomainReportRow[];
  /** Why the domains were not (all) probed, when they were not. */
  domainsNote?: "skipped_no_host_port" | "probe_unavailable";
  rebootRequired: RebootFlagVerdict;
  /** A closed code for a failure (never raw output). */
  reason?: RebootFailureReason;
  summary: { containersOk: number; containersExpected: number; domainsOk: number; domainsExpected: number };
}

export const REBOOT_FAILURE_REASONS = [
  "snapshot_failed",
  "agent_offline",
  "busy_patch",
  "busy_deploy",
  "unsupported",
  "start_failed",
  "interrupted",
  "host_did_not_reboot",
  "agent_never_returned",
  "docker_inactive",
  "state_unreadable",
] as const;
export type RebootFailureReason = (typeof REBOOT_FAILURE_REASONS)[number];

/** 2xx, 3xx and 401 mean the proxy routed the host to a live backend (401: the app answers, it just wants a login). */
export function domainStatusIsUp(status: number): boolean {
  return (status >= 200 && status < 400) || status === 401;
}

export interface VerificationInput {
  snapshot: RebootSnapshot;
  /** null: the state could not be read this round. */
  state: RebootStateRead | null;
  /** null: not probed this round. */
  domains: DomainProbeRead | null;
  rebootRequired: boolean | null;
  /** The window is over: whatever is not ok now stays that way. */
  final: boolean;
}

export interface VerificationOutcome {
  report: RebootReport;
  /** No need to poll further: either everything is ok, or the window is over. */
  settled: boolean;
  result: Extract<RebootResult, "ok" | "degraded" | "failed"> | null;
}

/** Judge one post-reboot read against the snapshot. Pure. Everything not yet ok is `pending` while the window is open
 *  (containers restart, healthchecks start, the proxy takes a moment) and counts as bad only at the end. */
export function evaluateVerification(input: VerificationInput): VerificationOutcome {
  const { snapshot, state, domains, final } = input;
  const byName = new Map((state?.containers ?? []).map((c) => [c.name, c]));
  const dockerUp = state ? state.docker : null;

  const containers: ContainerReportRow[] = snapshot.containers.map((c) => {
    const base = { name: c.name, image: c.image, restartPolicy: c.restartPolicy, hadHealthcheck: c.health !== "none" };
    if (!isExpectedBack(c)) return { ...base, verdict: "skipped" as const };
    const now = byName.get(c.name);
    if (!state || dockerUp !== true) return { ...base, verdict: "pending" as const, detail: "unknown" };
    if (!now) return { ...base, verdict: "missing" as const, detail: "not present" };
    if (now.state !== "running") {
      const detail = now.state;
      // created / restarting: docker is bringing it up (a restart policy waits between attempts); not yet a verdict.
      if (now.state === "created" || now.state === "restarting") return { ...base, verdict: "pending" as const, detail };
      return { ...base, verdict: "missing" as const, detail };
    }
    if (c.health === "none") return { ...base, verdict: "ok" as const, detail: "running" };
    if (now.health === "healthy") return { ...base, verdict: "ok" as const, detail: "healthy" };
    if (now.health === "unhealthy") return { ...base, verdict: "unhealthy" as const, detail: "unhealthy" };
    return { ...base, verdict: "pending" as const, detail: now.health === "none" ? "running" : now.health }; // starting (start period)
  });

  let domainsNote: RebootReport["domainsNote"];
  let domainRows: DomainReportRow[];
  if (snapshot.probe === "skipped_no_host_port") {
    domainsNote = "skipped_no_host_port";
    domainRows = snapshot.domains.map((d) => ({ host: d.host, verdict: "unverified" as const, status: null }));
  } else if (domains?.unavailable) {
    domainsNote = "probe_unavailable";
    domainRows = snapshot.domains.map((d) => ({ host: d.host, verdict: "unverified" as const, status: null }));
  } else {
    domainRows = snapshot.domains.map((d) => {
      const code = domains?.codes.get(d.host);
      if (code === undefined) return { host: d.host, verdict: "pending" as const, status: null };
      return { host: d.host, verdict: domainStatusIsUp(code) ? ("ok" as const) : ("not_answering" as const), status: code === 0 ? null : code };
    });
  }

  const flag: RebootFlagVerdict = input.rebootRequired === null ? "unknown" : input.rebootRequired ? "still_set" : "cleared";

  const containersOk = containers.filter((c) => c.verdict === "ok").length;
  const containersExpected = containers.filter((c) => c.verdict !== "skipped").length;
  const probedDomains = domainRows.filter((d) => d.verdict !== "unverified");
  const domainsOk = domainRows.filter((d) => d.verdict === "ok").length;

  const rebooted = !!state?.bootId && state.bootId !== snapshot.bootId;
  const report: RebootReport = {
    version: 1,
    checkedAt: new Date().toISOString(),
    rebooted,
    docker: dockerUp === null ? "unknown" : dockerUp ? "active" : "inactive",
    containers,
    domains: domainRows,
    ...(domainsNote ? { domainsNote } : {}),
    rebootRequired: flag,
    summary: { containersOk, containersExpected, domainsOk, domainsExpected: probedDomains.length },
  };

  const dockerOk = dockerUp === true;
  const anyPending = containers.some((c) => c.verdict === "pending") || domainRows.some((d) => d.verdict === "pending");
  // Things that can still recover while the window is open (a container restarts, the proxy picks its route up).
  const dynamicBad = containers.some((c) => c.verdict === "missing" || c.verdict === "unhealthy") || domainRows.some((d) => d.verdict === "not_answering");
  // Things that will not change by waiting: the host still asks for a reboot; the probe cannot run at all.
  const staticBad = flag === "still_set" || domainsNote === "probe_unavailable";

  if (dockerOk && !anyPending && !dynamicBad) return { report, settled: true, result: staticBad ? "degraded" : "ok" };
  if (!final) return { report, settled: false, result: null };
  // The window is over. Pending items never became ok, so they count as bad now.
  if (!state) return { report: { ...report, reason: "state_unreadable" }, settled: true, result: "failed" };
  if (!dockerOk) return { report: { ...report, reason: "docker_inactive" }, settled: true, result: "failed" };
  return { report, settled: true, result: "degraded" };
}

/** A report for a reboot that never got as far as verifying (it failed or was cut short): nothing was verified, so no
 *  per-item rows, only the reason and what was expected. */
export function failureReport(reason: RebootFailureReason, snapshot: RebootSnapshot | null, rebooted = false): RebootReport {
  return {
    version: 1,
    checkedAt: new Date().toISOString(),
    rebooted,
    docker: "unknown",
    containers: [],
    domains: [],
    rebootRequired: "unknown",
    reason,
    summary: { containersOk: 0, containersExpected: (snapshot?.containers ?? []).filter(isExpectedBack).length, domainsOk: 0, domainsExpected: snapshot?.domains.length ?? 0 },
  };
}

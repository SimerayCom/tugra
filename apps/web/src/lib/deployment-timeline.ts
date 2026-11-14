import type { Deployment, DeploymentDetail } from "./types";

export type TimelineStepKey = "queued" | "started" | "finished";
export type TimelineStepState = "done" | "active" | "pending" | "skipped";

export interface TimelineStep {
  key: TimelineStepKey;
  /** ISO timestamp when the step happened; null when it has not (yet) happened. */
  at: string | null;
  state: TimelineStepState;
}

export interface DeploymentTimeline {
  steps: TimelineStep[];
  /** createdAt → startedAt; null while still queued or when startedAt is unknown (legacy rows). */
  queueWaitMs: number | null;
  /** startedAt → finishedAt (durationMs); null while not finished. */
  runMs: number | null;
}

const TERMINAL = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

/**
 * The three-step status timeline of a deployment (queued → started → finished), as pure data for the detail
 * page. Deterministic; a legacy row without startedAt shows the start step as skipped (unknown), never as a
 * fake timestamp, and a cancelled-while-queued row ends without a start.
 */
export function buildTimeline(d: Pick<Deployment, "status" | "createdAt" | "startedAt" | "durationMs"> & Partial<Pick<DeploymentDetail, "finishedAt">>): DeploymentTimeline {
  const terminal = TERMINAL.has(d.status);
  const startedAt = d.startedAt ?? null;
  const finishedAt = d.finishedAt ?? null;
  const started: TimelineStep = {
    key: "started",
    at: startedAt,
    state: startedAt ? "done" : d.status === "QUEUED" ? "active" : terminal ? "skipped" : "active",
  };
  // A terminal row without a derivable finish time (cancelled while queued, hub-restart reap, legacy) shows the
  // step as unknown rather than a green "done" with no timestamp.
  const finished: TimelineStep = {
    key: "finished",
    at: finishedAt,
    state: terminal ? (finishedAt ? "done" : "skipped") : d.status === "RUNNING" ? "active" : "pending",
  };
  const createdMs = Date.parse(d.createdAt);
  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  const queueWaitMs = Number.isFinite(createdMs) && Number.isFinite(startedMs) ? Math.max(0, startedMs - createdMs) : null;
  const runMs = terminal && d.durationMs != null ? d.durationMs : null;
  return { steps: [{ key: "queued", at: d.createdAt, state: "done" }, started, finished], queueWaitMs, runMs };
}

// Pure reduction of the container-health poll's ContainerState rows into one per-app health verdict.
// No imports: shared by the service (DB rows in) and the specs.

export type HealthState = "healthy" | "unhealthy" | "starting" | "none" | "unknown";
export type CheckType = "CMD" | "HTTP" | "NONE";

export interface AppContainerHealth {
  state: HealthState;
  /** The app's resolved check type (deploy-gate config). HTTP/auto checks gate the deploy only; the
   *  Docker-reported `state` is non-null only when the container has a Docker HEALTHCHECK (CMD). */
  checkType: CheckType;
  containers: number;
  observedAt: string | null;
}

export const UNKNOWN_HEALTH = (checkType: CheckType): AppContainerHealth => ({ state: "unknown", checkType, containers: 0, observedAt: null });

/** Three runner ticks (60s poll). An older row means the agent is offline or lagging, so it is not trusted. */
export const CONTAINER_STATE_MAX_AGE_MS = 180_000;

// Live app containers are `tugra_<id>` (+ `-<service>-<n>` for compose, `.<slot>.<task>` for swarm). `_` is not in
// the id class, so `tugra_<id>__rollout` / `__prev` and the `tugra_db_*` / `tugra_dbv_*` database containers never match.
const NAME_RE = /^tugra_([A-Za-z0-9]+)(?:[-.].*)?$/;

export const appIdOfContainer = (name: string): string | null => NAME_RE.exec(name)?.[1] ?? null;

/** True when `name` is a live container of `appId`: exact, `-` prefixed, or (clustered only) `.` prefixed.
 *  The required delimiter keeps a sibling id that merely starts with this one's from matching. */
export function liveContainerOf(appId: string, clustered: boolean, name: string, project?: string): boolean {
  // An adopted compose stack keeps its own project name (`<project>-<service>-<n>`), not `tugra_<id>`.
  const prefix = project ?? `tugra_${appId}`;
  if (name === prefix) return true;
  if (name.startsWith(`${prefix}-`)) return true;
  return clustered && name.startsWith(`${prefix}.`);
}

export interface ContainerStateRow {
  status: string;
  health: string | null;
  updatedAt: Date;
}

const RANK: Record<"unhealthy" | "starting" | "healthy" | "none", number> = { unhealthy: 3, starting: 2, healthy: 1, none: 0 };

function rowState(r: ContainerStateRow): "unhealthy" | "starting" | "healthy" | "none" | null {
  switch (r.status) {
    case "restarting":
      return "unhealthy"; // a crash-loop must not read as plain "Running"
    case "created":
      return "starting";
    case "running":
      return r.health === "healthy" || r.health === "unhealthy" || r.health === "starting" ? r.health : "none";
    default:
      return null; // exited / dead / paused (e.g. a compose init container) never drives health
  }
}

export function reduceHealth(rows: readonly ContainerStateRow[], checkType: CheckType, now: number): AppContainerHealth {
  let worst: "unhealthy" | "starting" | "healthy" | "none" | null = null;
  let count = 0;
  let newest = 0;
  for (const r of rows) {
    if (now - r.updatedAt.getTime() > CONTAINER_STATE_MAX_AGE_MS) continue;
    const s = rowState(r);
    if (!s) continue;
    count++;
    newest = Math.max(newest, r.updatedAt.getTime());
    if (worst === null || RANK[s] > RANK[worst]) worst = s;
  }
  if (worst === null) return UNKNOWN_HEALTH(checkType);
  return { state: worst, checkType, containers: count, observedAt: new Date(newest).toISOString() };
}

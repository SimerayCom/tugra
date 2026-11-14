import { z } from "zod";
import type { Deployment } from "@prisma/client";
import { diffSnapshots, type ConfigSnapshot } from "../deploy/config-snapshot";
import { INTERRUPTED_DEPLOY_NOTE } from "./deployment-reconcile.service";

/**
 * The deployment rows the API returns (list + detail), built by ONE mapper so the two can never drift, plus
 * the pure helpers behind the detail view's derived facts. Everything here is deterministic and tested; the
 * browser never has to regex log text to learn what happened.
 */

const ROLLOUT_MARKER = /^TUGRA_ROLLOUT:\s*(\S+)/;
/** Every state the deploy scripts emit (deploy-script.ts / swarm). The log is user build output, so anything else
 *  after the marker is ignored — a build cannot inject an arbitrary token into API rows (or the MCP tool result). */
export const ROLLOUT_STATES: ReadonlySet<string> = new Set([
  "healthy", "converged", "paused", "failed", "rolled_back", "rollback_failed", "reverted", "revert_failed",
  "soak_failed_no_prev", "relabel_failed", "rename_failed", "create_failed",
]);

/** The LAST known `TUGRA_ROLLOUT: <state>` marker the deploy script printed, or null. Mirrors the web's
 *  summarizeDeployLog so list and UI agree. */
export function parseRolloutState(logs: string | null | undefined): string | null {
  if (!logs) return null;
  let state: string | null = null;
  for (const line of logs.split("\n")) {
    const m = ROLLOUT_MARKER.exec(line.trim());
    if (m && ROLLOUT_STATES.has(m[1])) state = m[1];
  }
  return state;
}

export type DeploymentNote = "interrupted" | "recovering" | "auto_rollback" | "cancelled";

/** Honest one-word note about HOW a deploy ended (or is going), for the UI banner. null = nothing special. */
export function classifyNote(row: Pick<Deployment, "status" | "kind" | "exitCode" | "logs" | "phase">): DeploymentNote | null {
  if (row.status === "RUNNING" && row.phase === "RECOVERING") return "recovering";
  if (row.status === "CANCELLED") return "cancelled";
  if (row.status === "FAILED" && row.kind === "AUTO_ROLLBACK") return "auto_rollback";
  if (row.status === "FAILED" && row.exitCode === -1 && (row.logs ?? "").startsWith(INTERRUPTED_DEPLOY_NOTE)) return "interrupted";
  return null;
}

export type ActorKind = "user" | "webhook" | "preview" | "rollout" | "system" | "unknown";

/** Who asked for this deploy. `requestedBy` is a userId | "webhook" | "webhook:pr" | "system"; a rollout dispatch
 *  is recognised by its trigger. The user's display name is resolved by the caller (never the raw id). */
export function classifyActor(row: Pick<Deployment, "requestedBy" | "trigger">, userName: string | null): { kind: ActorKind; name: string | null } {
  if (row.trigger === "rollout") return { kind: "rollout", name: null };
  const r = row.requestedBy;
  if (!r) return { kind: "unknown", name: null };
  if (r === "webhook") return { kind: "webhook", name: null };
  if (r === "webhook:pr") return { kind: "preview", name: null };
  if (r === "system") return { kind: "system", name: null };
  return { kind: "user", name: userName };
}

/** Derived end time: (startedAt ?? createdAt) + durationMs. null while running / for legacy rows without a duration. */
export function finishedAtOf(row: Pick<Deployment, "startedAt" | "createdAt" | "durationMs" | "status">): Date | null {
  if (row.status === "QUEUED" || row.status === "RUNNING" || row.durationMs == null) return null;
  const from = row.startedAt ?? row.createdAt;
  return new Date(new Date(from).getTime() + row.durationMs);
}

/** Is a SUCCESS row a rollback target? Its artifact must still exist: the compose YAML snapshot for compose apps
 *  (recorded at deploy START, hence the status gate), else a local tag / registry ref / pinned digest. */
export function isRollbackable(row: Pick<Deployment, "status" | "imageTag" | "registryImage" | "imageDigest">, snapshot: ConfigSnapshot | null, isCompose: boolean): boolean {
  return row.status === "SUCCESS" && (isCompose ? !!snapshot?.composeFile : !!(row.imageTag || row.registryImage || row.imageDigest));
}

/** Internal bookkeeping that never leaves the hub (lease / recovery columns + the raw snapshot). */
const STRIP = ["configSnapshot", "ownerId", "heartbeatAt", "phase", "agentReqId", "agentServerId", "deadlineAt", "dispatchPlan"] as const;

export interface DeploymentRowOpts {
  isCompose: boolean;
  /** The nearest OLDER snapshot to diff against (null = none → empty change list). */
  prevSnapshot: ConfigSnapshot | null;
  /** Omit `logs` (the list's heavy column) — `rollout` and `hasLogs` are computed before it is dropped. */
  slim?: boolean;
}

/** The ONE row mapper shared by the list and the detail endpoint. */
export function toDeploymentRow(d: Deployment, opts: DeploymentRowOpts) {
  const snapshot = (d.configSnapshot as ConfigSnapshot | null) ?? null;
  const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !(STRIP as readonly string[]).includes(k))) as Omit<Deployment, (typeof STRIP)[number]>;
  const row = {
    ...rest,
    configChanges: snapshot ? diffSnapshots(opts.prevSnapshot, snapshot) : [],
    rollbackable: isRollbackable(d, snapshot, opts.isCompose),
    rollout: parseRolloutState(d.logs),
    hasLogs: !!d.logs,
  };
  if (opts.slim) row.logs = null;
  return row;
}

export type DeploymentRow = ReturnType<typeof toDeploymentRow>;

// ── OpenAPI response shapes ──

export const ConfigChangeSchema = z.object({
  field: z.string(),
  kind: z.enum(["added", "removed", "changed"]),
  before: z.string().optional(),
  after: z.string().optional(),
});

export const DeploymentRowSchema = z.object({
  id: z.string(),
  appId: z.string(),
  status: z.enum(["QUEUED", "RUNNING", "SUCCESS", "FAILED", "CANCELLED"]),
  kind: z.string(),
  logs: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  imageTag: z.string().nullable(),
  registryImage: z.string().nullable(),
  imageDigest: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  trigger: z.string().nullable(),
  noCache: z.boolean(),
  requestedBy: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  commitSha: z.string().nullable(),
  commitMessage: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  createdAt: z.string().datetime(),
  configChanges: z.array(ConfigChangeSchema),
  rollbackable: z.boolean(),
  rollout: z.string().nullable(),
  hasLogs: z.boolean(),
});

export const DeploymentDetailSchema = DeploymentRowSchema.extend({
  /** The row whose snapshot `configChanges` is diffed against (null = no older snapshot exists). */
  diffBase: z.object({ id: z.string(), createdAt: z.string().datetime() }).nullable(),
  /** This deploy is the app's current version (latest SUCCESS). */
  isCurrent: z.boolean(),
  cancellable: z.boolean(),
  finishedAt: z.string().datetime().nullable(),
  actor: z.object({ kind: z.enum(["user", "webhook", "preview", "rollout", "system", "unknown"]), name: z.string().nullable() }),
  note: z.enum(["interrupted", "recovering", "auto_rollback", "cancelled"]).nullable(),
});

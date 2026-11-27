// "Move off Coolify": one secret-free progress view over the whole move (take over in place, clean up, consolidate projects, shut down
// Coolify). Counts, statuses and names only: no value, key, token, address or command ever appears here.
import type { CampaignStatus, CleanupStatus, ProjectMovePhase, TakeoverStatus } from "./coolify-takeover";

/** The four steps of the move, in the order the owner walks them. */
export const MOVE_OFF_STEPS = ["takeover", "cleanup", "consolidate", "shutdown"] as const;
export type MoveOffStep = (typeof MOVE_OFF_STEPS)[number];

/** What a server needs next. `not_coolify` = Coolify does not know this server (nothing to move off it). */
export const MOVE_OFF_SERVER_STAGES = ["agent", "takeover", "cleanup", "done", "hub", "not_coolify"] as const;
export type MoveOffServerStage = (typeof MOVE_OFF_SERVER_STAGES)[number];

export interface MoveOffServerRow {
  serverId: string;
  name: string;
  agentOnline: boolean;
  /** Coolify runs something here (the Coolify host, a server it manages or one with a takeover/cleanup on record). */
  coolify: boolean;
  /** The server that runs Coolify itself: shut down last, never taken over in place. */
  isCoolifyHub: boolean;
  /** Newest takeover status, or "none". */
  takeover: TakeoverStatus | "none";
  /** Newest cleanup status, or "none". */
  cleanup: CleanupStatus | "none";
  /** The stored failure code of that newest cleanup when it failed (a stable code, never a message); null otherwise. */
  cleanupFailure?: string | null;
  stage: MoveOffServerStage;
}

export type MoveOffGrantState = "none" | "active" | "expired" | "revoked";

export interface MoveOffHub {
  serverId: string;
  /** The team the Coolify host itself is in (often not the team being shown): the import session is made there. */
  teamId: string;
  name: string;
  /** When the Coolify database was last read, null before the first read. */
  readAt: string | null;
  /** Servers Coolify knows (from the last read). */
  knownServers: number | null;
  /** Coolify servers (not the host) that no Tugra server is linked or matched to yet; null before the first read. */
  unlinkedServers: number | null;
  /** State of the newest consent to read Coolify's secrets, and when an active one ends. */
  secrets: MoveOffGrantState;
  secretsExpiresAt: string | null;
  /** Newest agent install over SSH: how many servers are in which state. Absent before the first run. */
  ssh: { runId: string; finished: boolean; online: number; failed: number; skipped: number; pending: number; total: number } | null;
}

export interface MoveOffCampaignRow {
  id: string;
  /** The team the campaign belongs to: another team than the page's when the move spans several. */
  teamId?: string;
  label: string;
  status: CampaignStatus;
  runs: number;
  createdAt: string;
}

export interface MoveOffMoves {
  total: number;
  active: number;
  completed: number;
  failed: number;
  /** Newest phase, or null with no move yet. */
  latestPhase: ProjectMovePhase | null;
}

export interface MoveOffStepProgress {
  step: MoveOffStep;
  done: number;
  total: number;
  complete: boolean;
}

/**
 * What can still depend on Coolify besides the servers it manages: the apps, databases and services that still run on the Coolify host's own
 * machine (read from the last Coolify read; null = it could not be read, so nobody can say none is left), and the campaign runs that are not
 * COMPLETED (a campaign that planned runs counts the ones that never started too).
 */
export interface MoveOffLeft {
  host: number | null;
  runs: number;
}

export interface MoveOffStatusView {
  teamId: string;
  /** Null until a Coolify host is connected. */
  hub: MoveOffHub | null;
  servers: MoveOffServerRow[];
  campaigns: MoveOffCampaignRow[];
  projectMoves: MoveOffMoves;
  /** What still depends on Coolify besides the managed servers. Shutting Coolify down is offered only when both are zero. */
  left: MoveOffLeft;
  steps: MoveOffStepProgress[];
}

/** Only a VERIFIED takeover is far enough for the cleanup: the hub refuses one before (a swapped takeover may still need Coolify to give back to). */
const TAKEN_OVER: readonly string[] = ["VERIFIED"];
const MOVE_ACTIVE: readonly string[] = ["QUEUED", "PRECHECK", "MOVING", "VERIFYING", "CUTOVER", "ROLLING_BACK"];

/** Where a server stands. Pure: the hub and the tests share it. */
export function moveOffStageOf(r: Pick<MoveOffServerRow, "agentOnline" | "coolify" | "isCoolifyHub" | "takeover" | "cleanup">): MoveOffServerStage {
  if (r.isCoolifyHub) return "hub";
  if (!r.coolify) return "not_coolify";
  if (r.cleanup === "CLEANED") return "done";
  if (!r.agentOnline) return "agent";
  if (TAKEN_OVER.includes(r.takeover)) return "cleanup";
  return "takeover";
}

/** Progress per step from the rows. Consolidating projects is optional, so it only counts as complete once a move ran and none is running or failed. */
export function moveOffSteps(servers: readonly MoveOffServerRow[], moves: MoveOffMoves, hubReadAt: string | null, left: MoveOffLeft = { host: null, runs: 0 }): MoveOffStepProgress[] {
  const movers = servers.filter((s) => s.coolify && !s.isCoolifyHub);
  const taken = movers.filter((s) => s.stage === "cleanup" || s.stage === "done").length;
  const cleaned = movers.filter((s) => s.stage === "done").length;
  // A host-only Coolify (no managed server) has no row to clean: it settles once nothing is left on the host and no campaign run is open.
  const settled = hubReadAt !== null && cleaned === movers.length && left.host === 0 && left.runs === 0;
  return [
    { step: "takeover", done: taken, total: movers.length, complete: movers.length > 0 && taken === movers.length },
    { step: "cleanup", done: cleaned, total: movers.length, complete: movers.length > 0 && cleaned === movers.length },
    { step: "consolidate", done: moves.completed, total: moves.total, complete: moves.total > 0 && moves.active === 0 && moves.failed === 0 },
    { step: "shutdown", done: settled ? 1 : 0, total: 1, complete: false },
  ];
}

export function moveOffPhaseIsActive(phase: string): boolean {
  return MOVE_ACTIVE.includes(phase);
}

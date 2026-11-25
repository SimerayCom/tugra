import type { ProjectMovePhase, ProjectMoveView } from "@tugra/shared";
import { ApiError, type ProjectMovePreviewView } from "./api";

const TERMINAL: readonly ProjectMovePhase[] = ["COMPLETED", "ROLLED_BACK", "FAILED"];
export const moveIsActive = (m: Pick<ProjectMoveView, "phase"> | null | undefined): boolean => !!m && !TERMINAL.includes(m.phase);
/** Cancel is offered until an app has been cut over (the hub refuses later). */
export const moveCanCancel = (m: Pick<ProjectMoveView, "phase">): boolean => m.phase === "QUEUED" || m.phase === "PRECHECK" || m.phase === "MOVING";
/** The owner's undo is offered for a failed move that changed something (the hub says so; it re-checks everything). */
export const moveCanRollback = (m: Pick<ProjectMoveView, "phase" | "rollbackAvailable">): boolean => m.phase === "FAILED" && m.rollbackAvailable === true;
export const moveHasSafetyCopy = (m: Pick<ProjectMoveView, "phase" | "archiveUntil">): boolean => m.phase === "COMPLETED" && !!m.archiveUntil;

export function moveErrorKey(e: unknown): string {
  if (e instanceof ApiError) {
    const known = ["preflight_failed", "project_move_active", "move_not_cancellable", "move_not_completed", "nothing_to_purge", "confirm_name_mismatch", "move_not_rollbackable", "nothing_to_roll_back", "child_move_active"];
    if (e.code && known.includes(e.code)) return `projectMove.error.${e.code}`;
    if (e.status === 403) return "projectMove.error.forbidden";
  }
  return "projectMove.error.generic";
}

/** The blockers of a failed start (409 preflight_failed carries them), else of the last preview. */
export function blockersOf(e: unknown): ProjectMovePreviewView["blockers"] | null {
  if (e instanceof ApiError && e.code === "preflight_failed") {
    const b = e.data?.blockers;
    return Array.isArray(b) ? (b as ProjectMovePreviewView["blockers"]) : null;
  }
  return null;
}

/** A warning string stored on a move is `code` or `code:ref`. */
export function parseWarning(s: string): { code: string; ref?: string } {
  const i = s.indexOf(":");
  return i < 0 ? { code: s } : { code: s.slice(0, i), ref: s.slice(i + 1) };
}

/** Servers a project can move to: the team's online servers except the one it already sits on. */
export function targetServers<T extends { name: string; teamId: string; status: string }>(servers: readonly T[], teamId: string, excludeNames: readonly string[]): T[] {
  return servers.filter((s) => s.teamId === teamId && s.status === "ONLINE" && !excludeNames.includes(s.name));
}

/** The one server a project's resources all sit on (by name), or none when they are spread: then the hub decides. */
export function soleServerName(resources: ReadonlyArray<{ serverName: string | null }>): string[] {
  const names = new Set(resources.map((r) => r.serverName).filter((n): n is string => !!n));
  return names.size === 1 ? [...names] : [];
}

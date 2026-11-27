// "Take over in place" on one server: which flow the button starts. Pure decisions plus one small orchestrator over injected calls, so the
// rules are tested without a screen. Nothing here holds a value, key or token: ids, names and statuses only.
import type { MoveOffServerRow } from "@tugra/shared";
import { takeoverHref } from "./coolify-move";
import type { ImportAgentSession, MigrationRunStatus, MigrationRunSummary } from "./types";

/** Runs that can still carry a takeover: not stopped, undone or failed, and not a dry run (a dry run imports nothing). */
const DEAD: readonly MigrationRunStatus[] = ["ABORTING", "ABORTED", "ROLLING_BACK", "ROLLED_BACK", "REVERSING", "REVERSED", "FAILED", "DRY_RUN_DONE"];

/** The newest guided run that takes this very server over in place (same machine, proxy swap), or null. */
export function guidedRunFor(runs: readonly MigrationRunSummary[], serverId: string): MigrationRunSummary | null {
  const fit = runs.filter((r) => r.topology === "swap-proxy" && !r.dryRun && r.targetServerId === serverId && !DEAD.includes(r.status));
  fit.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return fit[0] ?? null;
}

export type TakeOverStart =
  | { kind: "open"; href: string }
  /** No guided run: the import session is made through the agent path and the wizard opens on this server. */
  | { kind: "start" };

export interface TakeOverCalls {
  listRuns: () => Promise<MigrationRunSummary[]>;
}

/**
 * What the button does for a row. A guided run that takes the server over opens that run (it drives the takeover); else a takeover on record
 * opens its page; with none, or one that was given back, the flow starts.
 */
export async function decideTakeOver(row: Pick<MoveOffServerRow, "serverId" | "takeover">, calls: TakeOverCalls): Promise<TakeOverStart> {
  const runs = await calls.listRuns().catch(() => [] as MigrationRunSummary[]);
  const run = guidedRunFor(runs, row.serverId);
  // a guided run drives its takeover: the row opens the run, where the approvals and the typed confirmations are (the takeover page only shows it)
  if (run) return { kind: "open", href: `/import/runs/${encodeURIComponent(run.id)}` };
  // a takeover that was given back holds nothing: it starts again like a server with none
  if (row.takeover !== "none" && row.takeover !== "GIVEN_BACK") return { kind: "open", href: takeoverHref(row.serverId) };
  return { kind: "start" };
}

/** True when the Coolify read has more than one team with projects: the owner must say which team's settings the session reads. */
export const needsTeamChoice = (teams: ImportAgentSession["teams"]): boolean => (teams?.length ?? 0) > 1;

/** True when a team ref is one of the session's own teams (the select can only offer those; this guards a stale value). */
export const isSessionTeam = (teams: ImportAgentSession["teams"], ref: string): boolean => !!ref && !!teams?.some((t) => t.ref === ref);

// Pure helpers for the guided "Move off Coolify" screens: which words, tones and links a server row gets. No fetching here.
import type { MoveOffGrantState, MoveOffServerRow, MoveOffServerStage, MoveOffStatusView, MoveOffStep, MoveOffStepProgress } from "@tugra/shared";

export type Tone = "ok" | "warn" | "muted" | "lapis" | "danger";

/** The four steps, A to D, with the letter the owner sees. */
export const STEP_LETTER: Record<MoveOffStep, "A" | "B" | "C" | "D"> = { takeover: "A", cleanup: "B", consolidate: "C", shutdown: "D" };

export const STAGE_TONE: Record<MoveOffServerStage, Tone> = { agent: "danger", takeover: "warn", cleanup: "lapis", done: "ok", hub: "muted", not_coolify: "muted" };

/** `servers.id` of the page that connects and reads a Coolify host. */
export const connectHref = (serverId: string): string => `/import/coolify-host?server=${encodeURIComponent(serverId)}`;
/** The takeover screen of one server (it shows the newest takeover; planning a new one starts from a run). */
export const takeoverHref = (serverId: string): string => `/import/inplace?serverId=${encodeURIComponent(serverId)}`;
export const MOVE_OFF_HREF = "/import/move-off-coolify";

/** Where a row's action leads, and which label key it carries. Null = nothing to do here. */
export function rowAction(r: MoveOffServerRow): { href: string; labelKey: string } | null {
  switch (r.stage) {
    case "agent":
    case "cleanup":
    case "done":
      return { href: `/servers/${encodeURIComponent(r.serverId)}`, labelKey: `coolifyMove.rowAction.${r.stage}` };
    case "takeover":
      return r.takeover === "none" ? { href: "/import", labelKey: "coolifyMove.rowAction.takeoverStart" } : { href: takeoverHref(r.serverId), labelKey: "coolifyMove.rowAction.takeoverOpen" };
    default:
      return null;
  }
}

/** Servers in the order the owner works through them: what needs attention first, finished last, others at the end. */
export function sortRows(rows: readonly MoveOffServerRow[]): MoveOffServerRow[] {
  const order: Record<MoveOffServerStage, number> = { agent: 0, takeover: 1, cleanup: 2, done: 3, hub: 4, not_coolify: 5 };
  return [...rows].sort((a, b) => order[a.stage] - order[b.stage] || a.name.localeCompare(b.name));
}

export function stepOf(v: MoveOffStatusView, step: MoveOffStep): MoveOffStepProgress {
  return v.steps.find((s) => s.step === step) ?? { step, done: 0, total: 0, complete: false };
}

/** The step the owner should work on now: the first one not complete; consolidating is skipped (it is optional), shutdown comes last. */
export function currentStep(v: MoveOffStatusView): MoveOffStep {
  if (!stepOf(v, "takeover").complete) return "takeover";
  if (!stepOf(v, "cleanup").complete) return "cleanup";
  return "shutdown";
}

/** Shutting Coolify down is offered only when every Coolify server is cleaned (and none is left to take over). */
export function readyToShutDown(v: MoveOffStatusView): boolean {
  return stepOf(v, "takeover").complete && stepOf(v, "cleanup").complete && v.projectMoves.active === 0;
}

export const GRANT_TONE: Record<MoveOffGrantState, Tone> = { none: "muted", active: "ok", expired: "warn", revoked: "muted" };

/** Servers of a row list that are Coolify's (the ones the steps count). */
export const coolifyRows = (rows: readonly MoveOffServerRow[]): MoveOffServerRow[] => rows.filter((r) => r.coolify && !r.isCoolifyHub);

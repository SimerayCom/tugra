import type { AppMove, AppMovePhase, MoveAckKey, MoveAcks, MovePreflightResult, ServerView } from "./types";

/** Phases in which the move is over (the banner stops polling, the lock is released). */
export const TERMINAL_PHASES: readonly AppMovePhase[] = ["COMPLETED", "ROLLED_BACK", "FAILED"];
export const isTerminalPhase = (p: AppMovePhase): boolean => TERMINAL_PHASES.includes(p);
/** Before the cutover a move can still be cancelled. */
export const CANCELLABLE_PHASES: readonly AppMovePhase[] = ["QUEUED", "PRECHECK", "STOPPING_SOURCE", "TRANSFERRING"];

/** The five visible steps of a running move. */
export const MOVE_STEPS = ["PRECHECK", "STOPPING_SOURCE", "TRANSFERRING", "DEPLOYING", "FINALIZING"] as const;
export type MoveStepKey = (typeof MOVE_STEPS)[number];
export type StepState = "done" | "active" | "pending" | "failed";

/** Per-step state for the banner's step list. A rolled-back/failed move marks the step it failed in. */
export function moveSteps(phase: AppMovePhase, failurePhase: AppMovePhase | null): { key: MoveStepKey; state: StepState }[] {
  const order = (p: AppMovePhase): number => (p === "QUEUED" ? -1 : (MOVE_STEPS as readonly string[]).indexOf(p));
  const reached = phase === "COMPLETED" ? MOVE_STEPS.length : phase === "ROLLING_BACK" || phase === "ROLLED_BACK" || phase === "FAILED" ? order(failurePhase ?? "PRECHECK") : order(phase);
  return MOVE_STEPS.map((key, i) => {
    if (phase === "COMPLETED") return { key, state: "done" as const };
    if (phase === "ROLLING_BACK" || phase === "ROLLED_BACK" || phase === "FAILED") return { key, state: i < reached ? ("done" as const) : i === reached ? ("failed" as const) : ("pending" as const) };
    return { key, state: i < reached ? ("done" as const) : i === reached ? ("active" as const) : ("pending" as const) };
  });
}

/** 0..1 for a volume's byte bar (parts done over parts); 0 until it is packed. */
export function volumeProgress(v: { parts: number; partsDone: number; sizeBytes: number | null; bytesDone: number }): number {
  if (v.parts > 0) return Math.min(1, v.partsDone / v.parts);
  return v.sizeBytes && v.sizeBytes > 0 ? Math.min(1, v.bytesDone / v.sizeBytes) : 0;
}

/** Hard blockers (cannot be acknowledged) vs the ones the operator can accept. */
export function splitBlockers(r: MovePreflightResult): { hard: MovePreflightResult["blockers"]; needsAck: MovePreflightResult["blockers"] } {
  return { hard: r.blockers.filter((b) => !b.ack), needsAck: r.blockers.filter((b) => b.ack) };
}

/** Continue is possible only without hard blockers AND with every required acknowledgement ticked. */
export function canContinue(r: MovePreflightResult | undefined, acks: MoveAcks): boolean {
  if (!r) return false;
  if (splitBlockers(r).hard.length > 0) return false;
  return r.requiredAcks.every((a) => acks[a] === true);
}

/** Only the ticked acknowledgements go to the hub (`acknowledge` is strict: known keys, booleans). */
export function ackPayload(r: MovePreflightResult | undefined, acks: MoveAcks): MoveAcks {
  const out: MoveAcks = {};
  for (const a of r?.requiredAcks ?? []) if (acks[a]) out[a as MoveAckKey] = true;
  return out;
}

export interface TargetChoice {
  value: string;
  label: string;
  disabled: boolean;
  offline: boolean;
}

/** Same-team servers, the current one excluded; an offline one is listed but disabled (with the reason in its label). */
export function targetChoices(servers: Pick<ServerView, "id" | "name" | "status" | "teamId">[], currentServerId: string, teamId: string, labels: { offline: string }): TargetChoice[] {
  return servers
    .filter((s) => s.teamId === teamId && s.id !== currentServerId)
    .map((s) => {
      const offline = s.status !== "ONLINE";
      return { value: s.id, label: offline ? `${s.name} (${labels.offline})` : s.name, disabled: offline, offline };
    });
}

/** Seconds -> "45s" / "3m 20s" / "2h 5m". */
export function fmtSeconds(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.round(sec))}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`.replace(" 0s", "");
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`.replace(" 0m", "");
}

/** The latest terminal move is worth showing on the app page for a day, or until the operator deals with it. */
export function bannerWorthy(m: AppMove | undefined, now = Date.now()): boolean {
  if (!m) return false;
  if (!isTerminalPhase(m.phase)) return true;
  if (m.phase === "FAILED") return m.needsAttention;
  if (m.phase === "ROLLED_BACK" && m.snapshotKept) return true; // a kept recovery copy waits for the operator
  if (m.phase === "COMPLETED" && m.archiveUntil && !m.sourcePurgedAt) return true; // the archive card (with Purge now)
  const done = m.finishedAt ? new Date(m.finishedAt).getTime() : 0;
  return now - done < 24 * 3600_000;
}

export const RETAIN_CHOICES = [0, 1, 3, 7, 14, 30, 90] as const;

/** Interval for the banner's poll: 2 s, backing off exponentially (max 30 s) after consecutive errors. */
export function pollInterval(failureCount: number): number {
  return Math.min(2000 * 2 ** Math.max(0, failureCount), 30_000);
}

/** apps.json key for a blocker/warning/failure code; falls back to the server's own message when we have no key. */
export function codeText(t: (k: string, v?: Record<string, string | number>) => string, kind: "Blocker" | "Warn" | "Err", code: string, fallback = "", vars: Record<string, string | number> = {}): string {
  const key = `apps.move${kind}_${code}`;
  const text = t(key, vars);
  return text === key ? fallback || code : text;
}

/** Flatten a details bag to the {param} values the translated strings use (arrays joined). */
export function detailVars(details: Record<string, unknown> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(details ?? {})) {
    if (typeof v === "number" || typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(", ");
  }
  return out;
}

/** apps.json key of an acknowledgement's checkbox text (the one irregular name: dropPrivilegedOptions). */
export function ackLabelKey(a: MoveAckKey): string {
  const base = a === "dropPrivilegedOptions" ? "dropPrivileged" : a;
  return `apps.moveAck${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}

/** The translated text of a move warning. A read-only member gets the bare code (the hub withholds env variable names), so
 *  the env warning has a variant without its key list. */
export function warningText(t: (k: string, v?: Record<string, string | number>) => string, w: { code: string; details?: Record<string, unknown> }): string {
  if (w.code === "env_may_reference_old_host" && !Array.isArray(w.details?.keys)) return codeText(t, "Warn", "env_may_reference_old_host_nokeys");
  return codeText(t, "Warn", w.code, "", detailVars(w.details));
}

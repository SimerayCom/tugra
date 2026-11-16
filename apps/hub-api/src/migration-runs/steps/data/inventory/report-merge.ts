/**
 * Pure merge of a parsed freeze report into the stored payload of a host (the latest state of its freeze/unfreeze), and the
 * verdict derived from it. Kept out of the ingest service so it is unit-tested directly.
 */
import type { FreezePart } from "./host-protocol";

export const FREEZE_STATES = ["stopped", "stop-failed", "restarted", "restart-failed", "error", "partial"] as const;
export type FreezeState = (typeof FREEZE_STATES)[number];

export interface FreezePayload {
  recorded: FreezePart["recorded"];
  stopped: Record<string, string>;
  started: Record<string, string>;
  unresolved: string[];
  outcome: "done" | "error" | null;
  errorCode: string | null;
  action: "freeze" | "unfreeze" | null;
}

export const asFreezePayload = (p: Record<string, unknown> | null): FreezePayload => ({
  recorded: Array.isArray(p?.recorded) ? (p!.recorded as FreezePayload["recorded"]) : [],
  stopped: p?.stopped && typeof p.stopped === "object" ? (p.stopped as Record<string, string>) : {},
  started: p?.started && typeof p.started === "object" ? (p.started as Record<string, string>) : {},
  unresolved: Array.isArray(p?.unresolved) ? (p!.unresolved as string[]) : [],
  outcome: p?.outcome === "done" || p?.outcome === "error" ? p.outcome : null,
  errorCode: typeof p?.errorCode === "string" ? p.errorCode : null,
  action: p?.action === "freeze" || p?.action === "unfreeze" ? p.action : null,
});

export function mergeFreeze(prev: Record<string, unknown> | null, part: FreezePart): { state: FreezeState; payload: FreezePayload } {
  const old = asFreezePayload(prev);
  const rerunOfRecord = part.recorded.length > 0 && part.unresolved.length === 0 && old.unresolved.length > 0;
  const payload: FreezePayload = {
    recorded: part.recorded.length ? part.recorded : old.recorded,
    stopped: { ...old.stopped, ...part.stopped },
    started: { ...old.started, ...part.started },
    unresolved: part.outcome !== null && !rerunOfRecord ? part.unresolved : part.unresolved.length ? part.unresolved : old.unresolved,
    outcome: part.outcome,
    errorCode: part.outcome === "error" ? part.errorCode : null,
    action: part.action ?? old.action,
  };
  return { state: freezeStateOf(payload), payload };
}

/** `error` (the script stopped early), `stopped` / `stop-failed` (every recorded container stopped or gone, or not), `restarted` / `restart-failed`, else `partial`. */
export function freezeStateOf(p: FreezePayload): FreezeState {
  if (p.outcome === "error") return "error";
  if (p.outcome !== "done") return "partial";
  if (p.action === "unfreeze") return Object.values(p.started).every((o) => o === "started" || o === "gone") ? "restarted" : "restart-failed";
  return p.recorded.every((c) => p.stopped[c.id] === "stopped" || p.stopped[c.id] === "gone") && Object.values(p.stopped).every((o) => o === "stopped" || o === "gone") ? "stopped" : "stop-failed";
}

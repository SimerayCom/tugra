/**
 * The write-gap attestation of FREEZE (R42/N2), pure. The operator's `tick-gap-accepted` attestation is a statement about ONE gap
 * (the one the gate showed when it was given), so it records that gap in its note (`gapMinutes=<n>`, written by the hub when the
 * attestation is recorded, see `MigrationRunsService.evidence`) and only covers a gap that is not longer. A later, larger estimate
 * (DATA_SEED re-measures the volumes) voids it and the step asks again.
 */
import type { TickGap } from "./data-logic";

export const TICK_GAP_CHECK = "tick-gap-accepted";
/** The id of the gate check that carries the gap. */
export const TICK_GAP_GATE_CHECK = "freeze.tick-gap";
export const TICK_GAP_CODES = { exceeded: "freeze.tick-gap-exceeded", attested: "freeze.tick-gap-attested", within: "freeze.tick-gap-within" } as const;

const NOTE_RE = /^gapMinutes=(\d{1,9}|unknown)(?: |$)/;
const NOTE_MAX = 500;

/** The note a tick-gap attestation is stored with: the gap it was given for, then the operator's own words. */
export function tickGapNote(gapMinutes: number | null | undefined, operatorNote?: string): string {
  const head = `gapMinutes=${typeof gapMinutes === "number" && Number.isFinite(gapMinutes) ? Math.max(0, Math.round(gapMinutes)) : "unknown"}`;
  return (operatorNote ? `${head} ${operatorNote}` : head).slice(0, NOTE_MAX);
}

/** The gap an attestation was given for: a number of minutes, `"unknown"` (the estimate could not be told), or null (it records none). */
export function attestedGapOf(a: { note?: string | undefined }): number | "unknown" | null {
  const m = NOTE_RE.exec(a.note ?? "");
  if (!m) return null;
  return m[1] === "unknown" ? "unknown" : Number(m[1]);
}

/**
 * Does the newest tick-gap attestation still cover the current gap? It does when it was given for a gap at least as long, or for an
 * unknown one while the estimate is still unknown. One that records no gap (written by hand, or before the gap was recorded) covers nothing.
 */
export function tickGapCovered(attestations: ReadonlyArray<{ checkId: string; note?: string | undefined }>, gap: Pick<TickGap, "gapMinutes">): boolean {
  const latest = [...attestations].reverse().find((a) => a.checkId === TICK_GAP_CHECK);
  if (!latest) return false;
  const given = attestedGapOf(latest);
  if (given === null) return false;
  if (given === "unknown") return gap.gapMinutes === null;
  return gap.gapMinutes !== null && gap.gapMinutes <= given;
}

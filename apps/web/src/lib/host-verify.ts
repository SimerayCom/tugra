// "Check these machines automatically" (Coolify hub takeover): which rows of the match step are worth a probe, and how far a check is.
// A probe asks the Coolify host's agent to read a machine's own identity over Coolify's SSH access (read-only, nothing installed).
import { COOLIFY_SSH_UUID_RE } from "@tugra/shared/dist/coolify-ssh";
import type { CoolifySshRunView } from "./coolify-ssh";
import type { MatchRow } from "./coolify-agent";
import type { ChecklistRow } from "./coolify-takeover";

/**
 * The rows a check can settle: a Coolify server (not the Coolify host itself) that the hub matched only by an address guess ("probably the
 * same") or could not decide ("not sure"), and that the owner has not answered for. A machine already matched by its identity, one the owner
 * answered, and one with no Tugra counterpart at all gain nothing from a probe.
 */
export function verifiableRows(rows: readonly Pick<MatchRow, "ref" | "controlPlane" | "kind" | "status" | "answeredByOwner">[]): string[] {
  return rows
    .filter((r) => !r.controlPlane && !r.answeredByOwner && (r.kind === "probable" || r.status === "ambiguous") && COOLIFY_SSH_UUID_RE.test(r.ref))
    .map((r) => r.ref);
}

export interface VerifyProgress {
  total: number;
  /** Targets the probe has finished with (read or failed). */
  done: number;
  /** Targets whose machine showed its identity. */
  verified: number;
  failed: number;
  finished: boolean;
}

export function verifyProgress(run: Pick<CoolifySshRunView, "targets" | "finished"> | null | undefined): VerifyProgress {
  const ts = run?.targets ?? [];
  const verified = ts.filter((t) => t.state === "VERIFIED").length;
  const failed = ts.filter((t) => t.state === "FAILED").length;
  return { total: ts.length, done: verified + failed, verified, failed, finished: run?.finished === true };
}

/**
 * The servers of the Coolify servers checklist that are already in Tugra but only "probably" the same machine, as the rows the check takes.
 * The hub says which ones (`probable`); nothing is guessed here.
 */
export function probableChecklistRows(rows: readonly ChecklistRow[]): MatchRow[] {
  return rows
    .filter((r) => r.state === "already_added" && r.probable === true)
    .map((r) => ({
      ref: r.coolifyServerUuid,
      name: r.name,
      controlPlane: false,
      kind: "probable",
      status: "probable",
      tugraServerId: r.tugraServerId,
      tugraName: null,
      agentOnline: true,
      answeredByOwner: false,
      evidence: [],
      identityConflict: false,
    }));
}

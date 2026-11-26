// Install the Tugra agent on the servers a Coolify knows, over Coolify's own SSH keys (Coolify hub takeover, lane C).
// The shapes mirror @tugra/shared (coolify-ssh.ts). Nothing here holds a token, a key or a command line.
import type { CoolifySshRunView, CoolifySshTargetState, CoolifySshTargetView } from "@tugra/shared";
import type { ChecklistRow } from "./coolify-takeover";

export type { CoolifySshRunView, CoolifySshTargetState, CoolifySshTargetView } from "@tugra/shared";

/** The rows that still have no agent and can be installed over SSH: not the Coolify host, not one that is already in Tugra or has no access. */
export function sshCandidates(rows: readonly ChecklistRow[]): ChecklistRow[] {
  return rows.filter((r) => r.state === "not_generated" || r.state === "waiting" || r.state === "expired" || r.state === "ambiguous");
}

export type RunPhase = "probing" | "ready" | "installing" | "uninstalling" | "done";

const INSTALLING: CoolifySshTargetState[] = ["TOKEN_MINTED", "INSTALLING", "WAIT_ENROLL"];

/** Where a run is, in one word: the probe is going, the owner can install, an install or removal is going, or nothing is left to do. */
export function runPhase(run: Pick<CoolifySshRunView, "targets"> | null | undefined): RunPhase {
  const ts = run?.targets ?? [];
  if (ts.some((t) => t.state === "UNINSTALLING")) return "uninstalling";
  if (ts.some((t) => INSTALLING.includes(t.state))) return "installing";
  if (ts.some((t) => t.state === "PLANNED" || t.state === "PROBING")) return "probing";
  if (ts.some((t) => t.state === "READY")) return "ready";
  return "done";
}

export interface RunCounts {
  total: number;
  ready: number;
  online: number;
  skipped: number;
  failed: number;
  removable: number;
  working: number;
}

export function runCounts(run: Pick<CoolifySshRunView, "targets"> | null | undefined): RunCounts {
  const ts = run?.targets ?? [];
  const n = (f: (t: CoolifySshTargetView) => boolean) => ts.filter(f).length;
  return {
    total: ts.length,
    ready: n((t) => t.state === "READY"),
    online: n((t) => t.state === "ONLINE"),
    skipped: n((t) => t.state === "SKIPPED_PRESENT" || t.state === "SKIPPED_FOREIGN"),
    failed: n((t) => t.state === "FAILED"),
    removable: n((t) => t.canRemove),
    working: n((t) => ["PLANNED", "PROBING", "TOKEN_MINTED", "INSTALLING", "WAIT_ENROLL", "UNINSTALLING"].includes(t.state)),
  };
}

/** Poll while something is working, stop when the run is finished. */
export function pollInterval(run: Pick<CoolifySshRunView, "targets" | "finished"> | null | undefined): number | false {
  if (!run) return false;
  return runCounts(run).working > 0 ? 2500 : false;
}

const TONE: Record<CoolifySshTargetState, "muted" | "gold" | "lapis" | "danger" | "warn" | "ok"> = {
  PLANNED: "muted",
  PROBING: "lapis",
  SKIPPED_PRESENT: "ok",
  SKIPPED_FOREIGN: "warn",
  READY: "gold",
  FAILED: "danger",
  TOKEN_MINTED: "lapis",
  INSTALLING: "lapis",
  WAIT_ENROLL: "lapis",
  ONLINE: "ok",
  UNINSTALLING: "lapis",
  REMOVED: "muted",
  VERIFIED: "ok",
};
export const stateTone = (s: CoolifySshTargetState) => TONE[s];

/** The number the owner types, as the hub expects it. */
export const confirmText = (n: number): string => String(n);

export interface SourceAgentGap {
  ref: string;
  name: string;
  state: "no_agent" | "offline";
}

/**
 * The source servers a move would take something from that have no online agent (the hub refuses a real run on the same grounds). `used` is the
 * set of source server refs that have something in scope. Servers the plan carries no verdict for are not flagged here: the hub says so when
 * it cannot verify.
 */
export function sourceAgentGapsOf(
  hosts: ReadonlyArray<{ ref: string; name?: string; tugra?: unknown; agentOnline?: boolean }> | undefined,
  used: ReadonlySet<string>,
): SourceAgentGap[] {
  const out: SourceAgentGap[] = [];
  for (const h of hosts ?? []) {
    if (!used.has(h.ref) || h.agentOnline !== false) continue;
    out.push({ ref: h.ref, name: h.name?.trim() || h.ref, state: h.tugra ? "offline" : "no_agent" });
  }
  return out;
}

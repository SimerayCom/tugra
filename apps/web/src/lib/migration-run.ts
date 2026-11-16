import type {
  MigrationRunApprovalBinding,
  MigrationRunCheckStatus,
  MigrationRunConfirmKind,
  MigrationRunCreateInput,
  MigrationRunEvent,
  MigrationRunEvidenceKind,
  MigrationRunGate,
  MigrationRunGateCheck,
  MigrationRunStepView,
  MigrationRunMode,
  MigrationRunNextAction,
  MigrationRunOptions,
  MigrationRunParamValue,
  MigrationRunParams,
  MigrationRunProgress,
  MigrationRunProgressUnit,
  MigrationRunStatus,
  MigrationRunStepKey,
  MigrationRunStepKind,
  MigrationRunStepStatus,
  MigrationRunRollbackClass,
  MigrationRunSummary,
  MigrationRunTopology,
  MigrationRunView,
  MigrationRunOwnerInputKey,
  ImportApplyExtras,
  ImportRemoteKind,
} from "./types";
import { formatBytes, formatDuration } from "./import";

/** Pure helpers for the guided-migration pages (tested in migration-run.test.ts). The hub speaks CODES + PARAMS only;
 *  every word the operator reads comes from `migrationRun.*` in the locale JSON through the literal-key maps below. */

type T = (key: string, vars?: Record<string, string | number>) => string;

// ───────────────────────────── vocabulary ─────────────────────────────

/** The 14 step keys in execution order (mirrors the hub contract). DECOMMISSION exists only for takeover runs. */
export const MIGRATION_RUN_STEP_KEYS: readonly MigrationRunStepKey[] = [
  "PREFLIGHT", "IMPORT", "DNS_PREPARE", "DATA_SEED", "FREEZE", "DATA_FINAL", "REMAP_ENV", "DEPLOY_DARK", "TLS_PREISSUE", "VERIFY", "CUTOVER", "OBSERVE", "FINALIZE", "DECOMMISSION",
];
export const MIGRATION_RUN_STATUSES: readonly MigrationRunStatus[] = [
  "QUEUED", "RUNNING", "WAITING", "PAUSED", "ABORTING", "ABORTED", "ROLLING_BACK", "ROLLED_BACK", "REVERSING", "REVERSED", "COMPLETED", "FAILED", "DRY_RUN_DONE",
];
export const MIGRATION_RUN_STEP_STATUSES: readonly MigrationRunStepStatus[] = [
  "PENDING", "RUNNING", "WAITING_OPERATOR", "WAITING_APPROVAL", "WAITING_TIMER", "PASSED", "FAILED", "SKIPPED", "COMPENSATED",
];

/** Settled for good: nothing more will change, so the page stops polling. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<MigrationRunStatus> = new Set(["ABORTED", "ROLLED_BACK", "REVERSED", "COMPLETED", "DRY_RUN_DONE"]);
export const isTerminalRun = (s: MigrationRunStatus): boolean => TERMINAL_RUN_STATUSES.has(s);
/** The hub is moving by itself right now (poll fast). */
const BUSY_RUN_STATUSES: ReadonlySet<MigrationRunStatus> = new Set(["QUEUED", "RUNNING", "ABORTING", "ROLLING_BACK", "REVERSING"]);

/** Literal-key maps, so the static key-usage test sees every key (same pattern as lib/cutover.ts). */
export const RUN_STATUS_KEY: Record<MigrationRunStatus, string> = {
  QUEUED: "migrationRun.status.QUEUED",
  RUNNING: "migrationRun.status.RUNNING",
  WAITING: "migrationRun.status.WAITING",
  PAUSED: "migrationRun.status.PAUSED",
  ABORTING: "migrationRun.status.ABORTING",
  ABORTED: "migrationRun.status.ABORTED",
  ROLLING_BACK: "migrationRun.status.ROLLING_BACK",
  ROLLED_BACK: "migrationRun.status.ROLLED_BACK",
  REVERSING: "migrationRun.status.REVERSING",
  REVERSED: "migrationRun.status.REVERSED",
  COMPLETED: "migrationRun.status.COMPLETED",
  FAILED: "migrationRun.status.FAILED",
  DRY_RUN_DONE: "migrationRun.status.DRY_RUN_DONE",
};
export const STEP_STATUS_KEY: Record<MigrationRunStepStatus, string> = {
  PENDING: "migrationRun.stepStatus.PENDING",
  RUNNING: "migrationRun.stepStatus.RUNNING",
  WAITING_OPERATOR: "migrationRun.stepStatus.WAITING_OPERATOR",
  WAITING_APPROVAL: "migrationRun.stepStatus.WAITING_APPROVAL",
  WAITING_TIMER: "migrationRun.stepStatus.WAITING_TIMER",
  PASSED: "migrationRun.stepStatus.PASSED",
  FAILED: "migrationRun.stepStatus.FAILED",
  SKIPPED: "migrationRun.stepStatus.SKIPPED",
  COMPENSATED: "migrationRun.stepStatus.COMPENSATED",
};
export const STEP_TITLE_KEY: Record<MigrationRunStepKey, string> = {
  PREFLIGHT: "migrationRun.steps.PREFLIGHT.title",
  IMPORT: "migrationRun.steps.IMPORT.title",
  DNS_PREPARE: "migrationRun.steps.DNS_PREPARE.title",
  DATA_SEED: "migrationRun.steps.DATA_SEED.title",
  FREEZE: "migrationRun.steps.FREEZE.title",
  DATA_FINAL: "migrationRun.steps.DATA_FINAL.title",
  REMAP_ENV: "migrationRun.steps.REMAP_ENV.title",
  DEPLOY_DARK: "migrationRun.steps.DEPLOY_DARK.title",
  TLS_PREISSUE: "migrationRun.steps.TLS_PREISSUE.title",
  VERIFY: "migrationRun.steps.VERIFY.title",
  CUTOVER: "migrationRun.steps.CUTOVER.title",
  OBSERVE: "migrationRun.steps.OBSERVE.title",
  FINALIZE: "migrationRun.steps.FINALIZE.title",
  DECOMMISSION: "migrationRun.steps.DECOMMISSION.title",
};
export const STEP_DESC_KEY: Record<MigrationRunStepKey, string> = {
  PREFLIGHT: "migrationRun.steps.PREFLIGHT.desc",
  IMPORT: "migrationRun.steps.IMPORT.desc",
  DNS_PREPARE: "migrationRun.steps.DNS_PREPARE.desc",
  DATA_SEED: "migrationRun.steps.DATA_SEED.desc",
  FREEZE: "migrationRun.steps.FREEZE.desc",
  DATA_FINAL: "migrationRun.steps.DATA_FINAL.desc",
  REMAP_ENV: "migrationRun.steps.REMAP_ENV.desc",
  DEPLOY_DARK: "migrationRun.steps.DEPLOY_DARK.desc",
  TLS_PREISSUE: "migrationRun.steps.TLS_PREISSUE.desc",
  VERIFY: "migrationRun.steps.VERIFY.desc",
  CUTOVER: "migrationRun.steps.CUTOVER.desc",
  OBSERVE: "migrationRun.steps.OBSERVE.desc",
  FINALIZE: "migrationRun.steps.FINALIZE.desc",
  DECOMMISSION: "migrationRun.steps.DECOMMISSION.desc",
};
export const STEP_KIND_KEY: Record<MigrationRunStepKind, string> = {
  auto: "migrationRun.kind.auto",
  operator: "migrationRun.kind.operator",
  approval: "migrationRun.kind.approval",
  timer: "migrationRun.kind.timer",
};
export const ROLLBACK_KEY: Record<MigrationRunRollbackClass, string> = {
  FREE: "migrationRun.rollback.FREE",
  UNDOABLE: "migrationRun.rollback.UNDOABLE",
  LOSSY_AFTER_PONR: "migrationRun.rollback.LOSSY_AFTER_PONR",
  IRREVERSIBLE: "migrationRun.rollback.IRREVERSIBLE",
};
export const EVIDENCE_KEY: Record<MigrationRunEvidenceKind, string> = {
  "hub-verified": "migrationRun.evidence.hub-verified",
  "migrator-reported": "migrationRun.evidence.migrator-reported",
  "operator-attested": "migrationRun.evidence.operator-attested",
};
export const EVIDENCE_HINT_KEY: Record<MigrationRunEvidenceKind, string> = {
  "hub-verified": "migrationRun.evidence.hint.hub-verified",
  "migrator-reported": "migrationRun.evidence.hint.migrator-reported",
  "operator-attested": "migrationRun.evidence.hint.operator-attested",
};
export const CHECK_STATUS_KEY: Record<MigrationRunCheckStatus, string> = {
  pass: "migrationRun.check.pass",
  fail: "migrationRun.check.fail",
  warn: "migrationRun.check.warn",
  unknown: "migrationRun.check.unknown",
};
export const MODE_KEY: Record<MigrationRunMode, string> = {
  copy: "migrationRun.mode.copy",
  takeover: "migrationRun.mode.takeover",
};
export const MODE_HINT_KEY: Record<MigrationRunMode, string> = {
  copy: "migrationRun.mode.copyHint",
  takeover: "migrationRun.mode.takeoverHint",
};
export const TOPOLOGY_KEY: Record<MigrationRunTopology, string> = {
  "two-box": "migrationRun.topology.two-box",
  "swap-proxy": "migrationRun.topology.swap-proxy",
};
export const TOPOLOGY_HINT_KEY: Record<MigrationRunTopology, string> = {
  "two-box": "migrationRun.topology.two-boxHint",
  "swap-proxy": "migrationRun.topology.swap-proxyHint",
};
export const DRY_KEY = {
  info: "migrationRun.dry.info",
  warn: "migrationRun.dry.warn",
  block: "migrationRun.dry.block",
  unknown: "migrationRun.dry.unknown",
} as const;
export const NEXT_KIND_KEY: Record<MigrationRunNextAction["kind"], string> = {
  operator: "migrationRun.next.operator",
  approval: "migrationRun.next.approval",
  timer: "migrationRun.next.timer",
  gate: "migrationRun.next.gate",
  session: "migrationRun.next.session",
  paused: "migrationRun.next.paused",
  failed: "migrationRun.next.failed",
  engine: "migrationRun.next.engine",
  none: "migrationRun.next.none",
};
export const UNIT_KEY: Record<MigrationRunProgressUnit, string> = {
  item: "migrationRun.units.item",
  byte: "migrationRun.units.byte",
  volume: "migrationRun.units.volume",
  host: "migrationRun.units.host",
  app: "migrationRun.units.app",
  database: "migrationRun.units.database",
  bucket: "migrationRun.units.bucket",
  second: "migrationRun.units.second",
};
export const OWNER_INPUT_LABEL_KEY: Record<MigrationRunOwnerInputKey, string> = {
  acmeEmail: "migrationRun.inputs.acmeEmail",
  allowBind: "migrationRun.inputs.allowBind",
  allowLiveShapeProbe: "migrationRun.inputs.allowLiveShapeProbe",
  sourceController: "migrationRun.inputs.sourceController",
};
export const OWNER_INPUT_HINT_KEY: Record<MigrationRunOwnerInputKey, string> = {
  acmeEmail: "migrationRun.inputs.acmeEmailHint",
  allowBind: "migrationRun.inputs.allowBindHint",
  allowLiveShapeProbe: "migrationRun.inputs.allowLiveShapeProbeHint",
  sourceController: "migrationRun.inputs.sourceControllerHint",
};
export const CONFIRM_PROMPT_KEY: Record<MigrationRunConfirmKind, string> = {
  none: "migrationRun.confirm.none",
  "run-id": "migrationRun.confirm.runId",
  "target-server": "migrationRun.confirm.targetServer",
  "target-server+source-host": "migrationRun.confirm.targetServerAndHost",
  "source-host": "migrationRun.confirm.sourceHost",
};

// ───────────────────────────── codes + params ─────────────────────────────

/** `migrationRun.codes.<code>` with dots turned into underscores (the locale JSON is flat, so a code that is the prefix
 *  of another code can never collide with it). */
export const codeKey = (code: string): string => `migrationRun.codes.${code.replace(/\./g, "_")}`;

/** Readable fallback for a code the locale does not know yet (a newer hub): "data-final.transfer-diverged" becomes
 *  "data final: transfer diverged". Derived from the code itself, never invented. */
export function humanizeCode(code: string): string {
  const parts = code.split(".").map((p) => p.replace(/-/g, " "));
  return parts.length > 1 ? `${parts[0]}: ${parts.slice(1).join(" ")}` : parts[0];
}

/** One param value as plain text for message interpolation: lists are comma-joined, null is a dash. */
export function paramText(v: MigrationRunParamValue | undefined): string {
  if (v === undefined || v === null) return "-";
  if (Array.isArray(v)) return v.map((x) => (x === null ? "-" : String(x))).join(", ");
  return String(v);
}

/** Params as interpolation vars; a list that is long is cut with a "+N" tail so a message never floods the screen. */
export function paramVars(params: MigrationRunParams | null | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (Array.isArray(v) && v.length > 5) out[k] = `${paramText(v.slice(0, 5))} +${v.length - 5}`;
    else if (typeof v === "number") out[k] = v;
    else out[k] = paramText(v);
  }
  return out;
}

/** Localize a hub code. An unknown code is shown humanized plus its params rather than hidden or guessed at. */
export function codeText(t: T, code: string, params?: MigrationRunParams | null): string {
  const key = codeKey(code);
  const vars = paramVars(params);
  const text = t(key, vars);
  if (text !== key) return text;
  const extra = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(", ");
  return t("migrationRun.codes.unknown", { code: humanizeCode(code), params: extra ? ` (${extra})` : "" });
}

// ───────────────────────────── colours + polling ─────────────────────────────

export function runStatusColor(s: MigrationRunStatus): string {
  switch (s) {
    case "RUNNING":
    case "QUEUED":
    case "ABORTING":
    case "ROLLING_BACK":
    case "REVERSING":
      return "var(--c-a)";
    case "WAITING":
    case "PAUSED":
    case "DRY_RUN_DONE":
      return "var(--c-am)";
    case "COMPLETED":
      return "var(--c-g)";
    case "FAILED":
      return "var(--c-r)";
    case "ABORTED":
    case "ROLLED_BACK":
    case "REVERSED":
      return "var(--c-tx3)";
  }
}

export function stepStatusColor(s: MigrationRunStepStatus): string {
  switch (s) {
    case "PASSED":
      return "var(--c-g)";
    case "RUNNING":
      return "var(--c-a)";
    case "WAITING_OPERATOR":
    case "WAITING_APPROVAL":
    case "WAITING_TIMER":
      return "var(--c-am)";
    case "FAILED":
      return "var(--c-r)";
    case "PENDING":
    case "SKIPPED":
    case "COMPENSATED":
      return "var(--c-tx3)";
  }
}

export const checkStatusColor = (s: MigrationRunCheckStatus): string => (s === "pass" ? "var(--c-g)" : s === "fail" ? "var(--c-r)" : "var(--c-am)");

/** Evidence trust order, weakest first: the badge never upgrades a weaker kind. */
export const evidenceTone = (k: MigrationRunEvidenceKind): "ok" | "warn" | "muted" => (k === "hub-verified" ? "ok" : k === "migrator-reported" ? "warn" : "muted");

/** Poll fast while the hub is moving by itself, slowly while it waits for a human, never once settled. */
export function runRefetchInterval(run: (Pick<MigrationRunView, "status"> & { steps?: Pick<MigrationRunStepView, "status">[] }) | undefined): number | false {
  if (!run) return 3000;
  if (isTerminalRun(run.status)) {
    // A settled run can still have an asynchronous step moving (a takeover's DECOMMISSION runs after COMPLETED), or
    // one counting down. A step waiting for a person changes only through an action, whose answer is adopted at once.
    const steps = run.steps ?? [];
    if (steps.some((s) => s.status === "RUNNING")) return 2000;
    return steps.some((s) => s.status === "WAITING_TIMER") ? 5000 : false;
  }
  return BUSY_RUN_STATUSES.has(run.status) ? 2000 : 5000;
}
export function runListRefetchInterval(rows: Pick<MigrationRunSummary, "status">[] | undefined): number {
  return (rows ?? []).some((r) => !isTerminalRun(r.status)) ? 4000 : 20000;
}

// ───────────────────────────── view helpers ─────────────────────────────

/** Done-fraction of a step's progress as 0-100, or null when the total is unknown (no invented percentage). */
export function progressPct(p: MigrationRunProgress | null | undefined): number | null {
  if (!p || p.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
}

/** "12 / 40 volumes", with bytes humanized; the unit word comes from the locale. */
export function progressText(t: T, p: MigrationRunProgress): string {
  if (p.unit === "byte") return `${formatBytes(p.done)} / ${formatBytes(p.total)}`;
  if (p.unit === "second") return `${formatDuration(p.done) ?? "0 s"} / ${formatDuration(p.total) ?? "0 s"}`;
  return t("migrationRun.progressOf", { done: p.done, total: p.total, unit: t(UNIT_KEY[p.unit]) });
}

/** Seconds left until an instant (never negative); null when there is none. */
export function secondsUntil(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.ceil((ms - now) / 1000)) : null;
}

/** The step rows to draw: DECOMMISSION only when the hub created its row (takeover), in step order. */
export function visibleSteps(run: Pick<MigrationRunView, "steps">): MigrationRunView["steps"] {
  return [...run.steps].sort((a, b) => a.idx - b.idx);
}

/** The first non-PENDING step that is not settled: the one the operator should look at. */
export function activeStep(run: Pick<MigrationRunView, "steps" | "currentStep">): MigrationRunView["steps"][number] | undefined {
  return run.steps.find((s) => s.key === run.currentStep) ?? run.steps.find((s) => s.status !== "PENDING" && s.status !== "PASSED" && s.status !== "SKIPPED" && s.status !== "COMPENSATED");
}

export function stepsSummary(run: Pick<MigrationRunView, "steps">): { passed: number; total: number } {
  const flow = run.steps.filter((s) => s.status !== "SKIPPED");
  return { passed: flow.filter((s) => s.status === "PASSED").length, total: flow.length };
}

/** The point of no return has been reached: abort is no longer offered, only the lossy reverse. */
export const isPastPonr = (run: Pick<MigrationRunView, "ponrAt">): boolean => !!run.ponrAt;

/** Gate checks that block the step (fail, or unknown which fails wherever data would move) and were not acked. */
export function blockingChecks(gate: MigrationRunGate | null | undefined): MigrationRunGateCheck[] {
  return (gate?.checks ?? []).filter((c) => (c.status === "fail" || c.status === "unknown") && !c.acked);
}

/** Checks that carry an owner input the operator can answer in the "Owner inputs" card. */
export const checksNeedingInput = (gate: MigrationRunGate | null | undefined): MigrationRunGateCheck[] => blockingChecks(gate).filter((c) => !!c.ownerInput);

/** Counts of checks by evidence kind (the trust summary above a gate). */
export function evidenceCounts(gate: MigrationRunGate | null | undefined): Record<MigrationRunEvidenceKind, number> {
  const out: Record<MigrationRunEvidenceKind, number> = { "hub-verified": 0, "migrator-reported": 0, "operator-attested": 0 };
  for (const c of gate?.checks ?? []) if (c.evidence && c.status === "pass") out[c.evidence] += 1;
  return out;
}

/** The step's dry-run projection, blocks first: a dry-run row that would stop the real run leads the list. */
export function dryRunItemsSorted(p: MigrationRunProgress | null | undefined): NonNullable<MigrationRunProgress["dryRun"]> {
  const rank = { block: 0, unknown: 1, warn: 2, info: 3 } as const;
  return [...(p?.dryRun ?? [])].sort((a, b) => rank[a.level] - rank[b.level]);
}
export function dryRunVerdict(run: Pick<MigrationRunView, "steps">): { blocks: number; unknown: number; warns: number } {
  const v = { blocks: 0, unknown: 0, warns: 0 };
  for (const s of run.steps) for (const i of s.progress?.dryRun ?? []) {
    if (i.level === "block") v.blocks += 1;
    else if (i.level === "unknown") v.unknown += 1;
    else if (i.level === "warn") v.warns += 1;
  }
  return v;
}

// ───────────────────────────── events ─────────────────────────────

export const MAX_EVENTS = 1000;
/** Merge a polled page into the accumulated log: unique by seq, ascending, capped to the newest MAX_EVENTS. */
export function mergeEvents(existing: MigrationRunEvent[], incoming: MigrationRunEvent[]): MigrationRunEvent[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map<number, MigrationRunEvent>();
  for (const e of existing) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return merged.length > MAX_EVENTS ? merged.slice(merged.length - MAX_EVENTS) : merged;
}

// ───────────────────────────── typed confirmation + approvals ─────────────────────────────

/** Names the operator must type for a confirmation kind, in order; null when a name the hub should know is missing
 *  (a deleted server), in which case the action stays blocked rather than accepting an empty match. */
export function confirmNames(kind: MigrationRunConfirmKind, run: Pick<MigrationRunView, "id" | "targetServerName" | "sourceHost">): string[] | null {
  const server = run.targetServerName?.trim() || null;
  const host = run.sourceHost?.trim() || null;
  switch (kind) {
    case "none":
      return [];
    case "run-id":
      return [run.id];
    case "target-server":
      return server ? [server] : null;
    case "source-host":
      return host ? [host] : null;
    case "target-server+source-host":
      return server && host ? [server, host] : null;
  }
}

/** The single `confirmName` string sent to the hub: the typed names joined by one space, in the order shown (the
 *  server name first, the source host last). */
export const joinConfirmNames = (typed: readonly string[]): string => typed.map((s) => s.trim()).join(" ");

export interface ApprovalDraft {
  /** The hash the operator was looking at when they started the form. */
  reviewedHash: string;
  acks: ReadonlySet<string>;
  typed: readonly string[];
  dataRisk: boolean;
}
export type ApprovalIssue = "stale" | "ack-missing" | "name-mismatch" | "name-unavailable" | "data-risk";

/** Why an approval cannot be submitted yet. An approval is bound to the hash of what was reviewed: when the live
 *  binding's `inputHash` moved on after the operator started, the form is `stale` and must be reviewed again. */
export function approvalIssues(binding: MigrationRunApprovalBinding, draft: ApprovalDraft, expected: string[] | null): ApprovalIssue[] {
  const out: ApprovalIssue[] = [];
  if (draft.reviewedHash !== binding.inputHash) out.push("stale");
  if (binding.requiredAcks.some((id) => !draft.acks.has(id))) out.push("ack-missing");
  if (expected === null) out.push("name-unavailable");
  else if (expected.length > 0 && (draft.typed.length !== expected.length || expected.some((n, i) => (draft.typed[i] ?? "").trim() !== n))) out.push("name-mismatch");
  if (binding.requiresDataRisk && !draft.dataRisk) out.push("data-risk");
  return out;
}

/** The request body of an approval: only acks the binding allows, the hash the operator reviewed, the joined names. */
export function approvalPayload(binding: MigrationRunApprovalBinding, draft: ApprovalDraft) {
  const allowed = new Set(binding.ackable);
  const acks = [...draft.acks].filter((id) => allowed.has(id) || binding.requiredAcks.includes(id));
  const name = joinConfirmNames(draft.typed);
  return {
    boundHash: draft.reviewedHash,
    acks,
    ...(name ? { confirmName: name } : {}),
    ...(binding.requiresDataRisk ? { acceptDataRisk: draft.dataRisk } : {}),
  };
}

/** The ackable gate checks of an approval, one row per check id (a check may repeat per subject), required first. */
export function ackRows(binding: MigrationRunApprovalBinding, gate: MigrationRunGate | null | undefined): Array<{ id: string; required: boolean; checks: MigrationRunGateCheck[] }> {
  const required = new Set(binding.requiredAcks);
  const ids = [...new Set([...binding.requiredAcks, ...binding.ackable])];
  const rows = ids.map((id) => ({ id, required: required.has(id), checks: (gate?.checks ?? []).filter((c) => c.id === id) }));
  return rows.sort((a, b) => Number(b.required) - Number(a.required));
}

/** True once a stored approval's expiry passed (the hub then puts the step back to waiting for a fresh one). */
export function approvalExpired(expiresAt: string | null | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const ms = new Date(expiresAt).getTime();
  return Number.isFinite(ms) && ms <= now;
}

type ReviewValue = { text: string };
/** One line of the approval's "what you are approving" list; keys ending in Sec/Bytes are humanized, booleans localized. */
export function reviewValue(t: T, key: string, value: MigrationRunParamValue): ReviewValue {
  if (typeof value === "boolean") return { text: t(value ? "migrationRun.yes" : "migrationRun.no") };
  if (typeof value === "number" && /Sec$/.test(key)) return { text: formatDuration(value) ?? String(value) };
  if (typeof value === "number" && /Bytes$/.test(key)) return { text: formatBytes(value) };
  return { text: paramText(value) };
}
/** Review keys the locale knows (the hub's keys for the approval's "what you are approving" list). */
export const REVIEW_LABEL_KEY: Record<string, string> = {
  stopList: "migrationRun.review.stopList",
  windowEstimateSec: "migrationRun.review.windowEstimateSec",
  hosts: "migrationRun.review.hosts",
  statefulHosts: "migrationRun.review.statefulHosts",
};
/** "windowEstimateSec" -> "window estimate sec": a readable label for a review key the locale does not know yet. */
export const humanizeKey = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
export function reviewLabel(t: T, key: string): string {
  const k = REVIEW_LABEL_KEY[key];
  return k ? t(k) : humanizeKey(key);
}

// ───────────────────────────── create (wizard launcher) ─────────────────────────────

export interface LaunchForm {
  sessionId: string;
  sourceKind: ImportRemoteKind;
  targetServerId: string;
  planHash: string;
  extras?: ImportApplyExtras;
  mode: MigrationRunMode;
  topology: MigrationRunTopology;
  dryRun: boolean;
  acmeEmail: string;
  allowBind: boolean;
  allowLiveShapeProbe: boolean;
  sourceController: "manual" | "api" | "agent";
  observeMinutes: string;
  options?: Partial<MigrationRunOptions>;
}

/** Practical email shape check (the hub validates strictly; this only keeps an obvious typo from being sent). */
export const looksLikeEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) && v.trim().length <= 254;

/** Why the launch form cannot be submitted (empty = ready). */
export function launchIssues(f: Pick<LaunchForm, "targetServerId" | "acmeEmail" | "observeMinutes">): Array<"target" | "email" | "observe"> {
  const out: Array<"target" | "email" | "observe"> = [];
  if (!f.targetServerId) out.push("target");
  if (f.acmeEmail.trim() && !looksLikeEmail(f.acmeEmail)) out.push("email");
  const n = Number(f.observeMinutes);
  if (f.observeMinutes.trim() === "" || !Number.isInteger(n) || n < 0 || n > 4320) out.push("observe");
  return out;
}

/** The `POST /migration-runs` body. An unanswered ACME email is sent as "unknown" (blocks only TLS and CUTOVER). The
 *  plan step's acks / service choices / data modes ride along so the run's frozen apply input equals what was reviewed. */
export function buildLaunchInput(f: LaunchForm): MigrationRunCreateInput {
  const e = f.extras ?? {};
  return {
    sessionId: f.sessionId,
    sourceKind: f.sourceKind,
    targetServerId: f.targetServerId,
    planHash: f.planHash,
    ...(e.acks?.length ? { acks: e.acks } : {}),
    ...(e.serviceChoices ? { serviceChoices: e.serviceChoices } : {}),
    ...(e.dbDataModes && Object.keys(e.dbDataModes).length ? { dbDataModes: e.dbDataModes } : {}),
    mode: f.mode,
    topology: f.topology,
    dryRun: f.dryRun,
    options: { ...(f.options ?? {}), observeMinutes: Number(f.observeMinutes) },
    inputs: {
      acmeEmail: f.acmeEmail.trim() ? f.acmeEmail.trim() : "unknown",
      allowBind: f.allowBind,
      allowLiveShapeProbe: f.allowLiveShapeProbe,
      sourceController: f.sourceController,
    },
  };
}

/** "Source host -> target server" label of a run row (names only; a deleted server reads as its id). */
export function runTitleParts(r: Pick<MigrationRunSummary, "sourceHost" | "sourceKind" | "targetServerName" | "targetServerId">): { source: string; target: string } {
  return { source: r.sourceHost ?? r.sourceKind, target: r.targetServerName ?? r.targetServerId };
}

// ───────────────────────────── errors ─────────────────────────────

/** Stable machine codes the hub puts in an error message (contract: 409 approval-stale / run-past-ponr, 403
 *  human-confirmation-required). A literal map so the key test sees them. */
export const ERROR_CODE_KEY: Record<string, string> = {
  "approval-stale": "migrationRun.errors.approval-stale",
  "run-past-ponr": "migrationRun.errors.run-past-ponr",
  "human-confirmation-required": "migrationRun.errors.human-confirmation-required",
};

/** An error from the hub as one readable line: a known machine code is localized, anything else is the hub's message. */
export function errorText(t: T, e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  for (const [code, key] of Object.entries(ERROR_CODE_KEY)) if (msg.includes(code)) return t(key);
  return msg || t("migrationRun.errors.generic");
}

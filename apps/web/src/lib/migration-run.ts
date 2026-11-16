import type {
  ImportPlanItem,
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
  MigrationRunReport,
  MigrationRunSummary,
  MigrationRunTopology,
  MigrationRunView,
  MigrationRunOwnerInputKey,
  MigrationRunOptions as RunOptionsType,
  MigrationRunServerMap,
  MigrationRunSourceVersionVerdict,
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
  "source-api-reported": "migrationRun.evidence.source-api-reported",
  "host-loop-reported": "migrationRun.evidence.host-loop-reported",
};
export const EVIDENCE_HINT_KEY: Record<MigrationRunEvidenceKind, string> = {
  "hub-verified": "migrationRun.evidence.hint.hub-verified",
  "migrator-reported": "migrationRun.evidence.hint.migrator-reported",
  "operator-attested": "migrationRun.evidence.hint.operator-attested",
  "source-api-reported": "migrationRun.evidence.hint.source-api-reported",
  "host-loop-reported": "migrationRun.evidence.hint.host-loop-reported",
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
  minioPolicy: "migrationRun.inputs.minioPolicy",
  workerPolicy: "migrationRun.inputs.workerPolicy",
  unlistedDbPolicy: "migrationRun.inputs.unlistedDbPolicy",
  orphanVolumePolicy: "migrationRun.inputs.orphanVolumePolicy",
};
export const OWNER_INPUT_HINT_KEY: Record<MigrationRunOwnerInputKey, string> = {
  acmeEmail: "migrationRun.inputs.acmeEmailHint",
  allowBind: "migrationRun.inputs.allowBindHint",
  allowLiveShapeProbe: "migrationRun.inputs.allowLiveShapeProbeHint",
  sourceController: "migrationRun.inputs.sourceControllerHint",
  minioPolicy: "migrationRun.inputs.minioPolicyHint",
  workerPolicy: "migrationRun.inputs.workerPolicyHint",
  unlistedDbPolicy: "migrationRun.inputs.unlistedDbPolicyHint",
  orphanVolumePolicy: "migrationRun.inputs.orphanVolumePolicyHint",
};

/** The choices of the four enum-valued owner inputs, in the order the hub documents them; the first is the fail-closed default. */
export const OWNER_POLICY_CHOICES = {
  minioPolicy: ["hold", "mirror", "external"],
  workerPolicy: ["hold-dark", "start-dark", "exclude"],
  unlistedDbPolicy: ["block", "carry", "skip"],
  orphanVolumePolicy: ["block", "skip"],
} as const;
export type OwnerPolicyKey = keyof typeof OWNER_POLICY_CHOICES;
/** Literal-key map for every choice label (`migrationRun.inputs.choice.<policy>.<value>`). */
export const OWNER_POLICY_CHOICE_KEY: Record<OwnerPolicyKey, Record<string, string>> = {
  minioPolicy: {
    hold: "migrationRun.inputs.choice.minioPolicy.hold",
    mirror: "migrationRun.inputs.choice.minioPolicy.mirror",
    external: "migrationRun.inputs.choice.minioPolicy.external",
  },
  workerPolicy: {
    "hold-dark": "migrationRun.inputs.choice.workerPolicy.hold-dark",
    "start-dark": "migrationRun.inputs.choice.workerPolicy.start-dark",
    exclude: "migrationRun.inputs.choice.workerPolicy.exclude",
  },
  unlistedDbPolicy: {
    block: "migrationRun.inputs.choice.unlistedDbPolicy.block",
    carry: "migrationRun.inputs.choice.unlistedDbPolicy.carry",
    skip: "migrationRun.inputs.choice.unlistedDbPolicy.skip",
  },
  orphanVolumePolicy: {
    block: "migrationRun.inputs.choice.orphanVolumePolicy.block",
    skip: "migrationRun.inputs.choice.orphanVolumePolicy.skip",
  },
};

/** The source version verdict labels and hints (the hub derives the verdict; the web only words it). */
export const VERSION_VERDICT_KEY: Record<MigrationRunSourceVersionVerdict, string> = {
  supported: "migrationRun.version.supported",
  newer: "migrationRun.version.newer",
  "too-old": "migrationRun.version.too-old",
  unknown: "migrationRun.version.unknown",
  unchecked: "migrationRun.version.unchecked",
};
export const VERSION_VERDICT_HINT_KEY: Record<MigrationRunSourceVersionVerdict, string> = {
  supported: "migrationRun.version.supportedHint",
  newer: "migrationRun.version.newerHint",
  "too-old": "migrationRun.version.too-oldHint",
  unknown: "migrationRun.version.unknownHint",
  unchecked: "migrationRun.version.uncheckedHint",
};
export const versionVerdictColor = (v: MigrationRunSourceVersionVerdict): string => (v === "supported" || v === "unchecked" ? "var(--c-g)" : v === "too-old" ? "var(--c-r)" : "var(--c-am)");
export const CONFIRM_PROMPT_KEY: Record<MigrationRunConfirmKind, string> = {
  none: "migrationRun.confirm.none",
  "run-id": "migrationRun.confirm.runId",
  "target-server": "migrationRun.confirm.targetServer",
  "target-servers": "migrationRun.confirm.targetServers",
  "target-server+source-host": "migrationRun.confirm.targetServerAndHost",
  "target-servers+source-host": "migrationRun.confirm.targetServersAndHost",
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
export const evidenceTone = (k: MigrationRunEvidenceKind): "ok" | "warn" | "muted" => (k === "hub-verified" ? "ok" : k === "operator-attested" ? "muted" : "warn");
/** Every evidence kind, strongest first (the order the summary lists them). */
export const EVIDENCE_KINDS: readonly MigrationRunEvidenceKind[] = ["hub-verified", "migrator-reported", "source-api-reported", "host-loop-reported", "operator-attested"];

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
  const out: Record<MigrationRunEvidenceKind, number> = { "hub-verified": 0, "migrator-reported": 0, "operator-attested": 0, "source-api-reported": 0, "host-loop-reported": 0 };
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

type ConfirmRun = Pick<MigrationRunView, "id" | "targetServerName" | "sourceHost"> & Partial<Pick<MigrationRunView, "targetServers">>;

/** The distinct target server names of a run, sorted by code point (what the hub expects, joined with ", "); null when a
 *  name the hub should know is missing (a deleted server), so the action stays blocked rather than accepting a partial list. */
export function targetServerNames(run: ConfirmRun): string[] | null {
  const list = run.targetServers && run.targetServers.length > 0 ? run.targetServers.map((s) => s.serverName?.trim() || null) : [run.targetServerName?.trim() || null];
  if (list.some((n) => !n)) return null;
  return [...new Set(list as string[])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Names the operator must type for a confirmation kind, in order; null when a name the hub should know is missing
 *  (a deleted server), in which case the action stays blocked rather than accepting an empty match. A multi-host run
 *  names EVERY target server (one entry each, sorted), so the point-of-no-return confirmation cannot skip a host. */
export function confirmNames(kind: MigrationRunConfirmKind, run: ConfirmRun): string[] | null {
  const server = run.targetServerName?.trim() || null;
  const host = run.sourceHost?.trim() || null;
  switch (kind) {
    case "none":
      return [];
    case "run-id":
      return [run.id];
    case "target-server":
      return server ? [server] : null;
    case "target-servers":
      return targetServerNames(run);
    case "source-host":
      return host ? [host] : null;
    case "target-server+source-host":
      return server && host ? [server, host] : null;
    case "target-servers+source-host": {
      const names = targetServerNames(run);
      return names && host ? [...names, host] : null;
    }
  }
}

/** The single `confirmName` string sent to the hub: the typed names joined by one space, in the order shown. For a
 *  multi-host kind the server names are joined with ", " (as the hub does) and the source host follows after one space. */
export function joinConfirmNames(typed: readonly string[], kind?: MigrationRunConfirmKind): string {
  const t = typed.map((s) => s.trim());
  if (kind === "target-servers") return t.join(", ");
  if (kind === "target-servers+source-host" && t.length >= 2) return `${t.slice(0, -1).join(", ")} ${t[t.length - 1]}`;
  return t.join(" ");
}

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
  const name = joinConfirmNames(draft.typed, binding.confirm);
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

/** At most this many source hosts in a placement map (the hub's own limit). */
export const SERVER_MAP_MAX = 64;
/** The placement ref of a resource whose source host the source did not say (item ref `<kind>:_:<ref>`). */
export const UNKNOWN_SOURCE_HOST = "_";

export interface SourceServerRow {
  /** The Coolify server uuid, or {@link UNKNOWN_SOURCE_HOST}. */
  ref: string;
  /** The server's name as the source calls it, when the plan lists it: what the operator reads instead of the uuid. */
  name?: string;
  apps: number;
  databases: number;
  services: number;
  volumes: number;
}

/** The source hosts a plan spans, read from the item refs (`<kind>:<serverRef|_>:<ref>`), sorted, with what lives on each. */
export function sourceServersOf(items: ReadonlyArray<Pick<ImportPlanItem, "itemRef" | "kind">>, hosts?: ReadonlyArray<{ ref: string; name?: string }>): SourceServerRow[] {
  const by = new Map<string, SourceServerRow>();
  for (const it of items) {
    const i1 = it.itemRef.indexOf(":");
    const i2 = i1 < 0 ? -1 : it.itemRef.indexOf(":", i1 + 1);
    const ref = i1 >= 0 && i2 > i1 ? it.itemRef.slice(i1 + 1, i2) || UNKNOWN_SOURCE_HOST : UNKNOWN_SOURCE_HOST;
    const row = by.get(ref) ?? { ref, apps: 0, databases: 0, services: 0, volumes: 0 };
    if (it.kind === "app") row.apps += 1;
    else if (it.kind === "database") row.databases += 1;
    else if (it.kind === "service") row.services += 1;
    else row.volumes += 1;
    by.set(ref, row);
  }
  const names = new Map((hosts ?? []).filter((h) => h.name && h.name.trim() !== "").map((h) => [h.ref, h.name!.trim()] as const));
  for (const row of by.values()) {
    const name = names.get(row.ref);
    if (name) row.name = name;
  }
  // by name when there is one (what the operator reads), else by ref; the unknown-host row stays last
  const key = (r: SourceServerRow) => (r.name ?? r.ref).toLowerCase();
  return [...by.values()].sort((a, b) => (a.ref === UNKNOWN_SOURCE_HOST ? 1 : b.ref === UNKNOWN_SOURCE_HOST ? -1 : key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/** The label of a source host: its name, else its ref. The placement rows and the run's placement card use it. */
export const sourceHostLabel = (names: Readonly<Record<string, string>>, ref: string): string => (Object.prototype.hasOwnProperty.call(names, ref) && names[ref] ? names[ref] : ref);

const PREFLIGHT_GATE_CHECKS = (run: Pick<MigrationRunView, "steps">): MigrationRunGateCheck[] => run.steps.find((s) => s.key === "PREFLIGHT")?.gate?.checks ?? [];

/** The source servers' names as PREFLIGHT recorded them (`preflight.hosts` carries two parallel lists), source ref to name.
 *  Empty until PREFLIGHT ran, and for a source that names none. */
export function sourceHostNames(run: Pick<MigrationRunView, "steps">): Record<string, string> {
  const p = PREFLIGHT_GATE_CHECKS(run).find((c) => c.id === "preflight.hosts")?.params;
  const refs = p?.refs;
  const names = p?.names;
  const out: Record<string, string> = Object.create(null);
  if (!Array.isArray(refs) || !Array.isArray(names)) return { ...out };
  refs.forEach((r, i) => {
    const n = names[i];
    if (typeof r === "string" && typeof n === "string" && n.trim() !== "") out[r] = n.trim();
  });
  return { ...out };
}

export interface HeldWorkers {
  /** What the run does with an app that serves no domain: keep it stopped until after the cutover, leave it out, or start it dark. */
  policy: "hold-dark" | "exclude" | "start-dark";
  count: number;
  /** Every worker's name, as PREFLIGHT listed them (at most 200). */
  names: string[];
}

/** The workers PREFLIGHT found (apps with no domain, or marked job runners) with what the run does with them (R26); null when the
 *  run has none or PREFLIGHT has not run. The whole list, not the ten names of the sentence. */
export function heldWorkersOf(run: Pick<MigrationRunView, "steps">): HeldWorkers | null {
  const c = PREFLIGHT_GATE_CHECKS(run).find((x) => x.id === "preflight.workers");
  const p = c?.params;
  if (!c || !p || !Array.isArray(p.workers)) return null;
  const names = p.workers.filter((n): n is string => typeof n === "string");
  const policy = p.policy === "exclude" || p.policy === "start-dark" ? p.policy : "hold-dark";
  if (names.length === 0) return null;
  return { policy, count: typeof p.count === "number" ? p.count : names.length, names };
}

/** The default placement of every source host: all on `defaultId` (the operator then moves some). */
export const defaultPlacement = (rows: readonly SourceServerRow[], defaultId: string): MigrationRunServerMap => Object.fromEntries(rows.map((r) => [r.ref, defaultId]));

/** Target servers a run touches, counted from a placement (the default is always one of them). */
export const placementTargetCount = (defaultId: string, map: MigrationRunServerMap | null | undefined): number => new Set([defaultId, ...Object.values(map ?? {})]).size;

export const HOST_LOOP_FORM_DEFAULTS = { keyDir: "/data/coolify/ssh/keys", parallel: "1", connectTimeoutSec: "15", retries: "1" } as const;
export interface HostLoopForm {
  keyDir: string;
  parallel: string;
  connectTimeoutSec: string;
  retries: string;
}
/** The hub's keyDir rule: absolute, only [A-Za-z0-9._/-], no `..` segment. */
export const validKeyDir = (p: string): boolean => /^\/[A-Za-z0-9._\/-]{0,200}$/.test(p) && !p.split("/").includes("..");
const intIn = (v: string, min: number, max: number): boolean => v.trim() !== "" && Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
/** A campaign label: 1-80 printable characters (the hub trims it). */
export const validCampaign = (v: string): boolean => {
  const c = v.trim();
  return c.length >= 1 && c.length <= 80 && !/\p{Cc}/u.test(c);
};

/** The owner policy inputs of the launch form; an empty string = left unanswered (the hub's fail-closed default applies). */
export interface LaunchPolicies {
  minioPolicy: string;
  workerPolicy: string;
  unlistedDbPolicy: string;
  orphanVolumePolicy: string;
}
export const EMPTY_POLICIES: LaunchPolicies = { minioPolicy: "", workerPolicy: "", unlistedDbPolicy: "", orphanVolumePolicy: "" };

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
  /** Source host -> Tugra server for a multi-host run; null/undefined = every resource on `targetServerId`. */
  placement?: MigrationRunServerMap | null;
  campaign?: string;
  sourceRunner?: RunOptionsType["sourceRunner"];
  hostLoop?: HostLoopForm;
  deployWaves?: RunOptionsType["deployWaves"];
  deployConcurrency?: string;
  largeDbMode?: NonNullable<RunOptionsType["largeDbMode"]>;
  stopSource?: boolean;
  policies?: LaunchPolicies;
}

/** Practical email shape check (the hub validates strictly; this only keeps an obvious typo from being sent). */
export const looksLikeEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) && v.trim().length <= 254;

export type LaunchIssue = "target" | "email" | "observe" | "placement" | "campaign" | "hostLoop" | "concurrency";

/** Why the launch form cannot be submitted (empty = ready). */
export function launchIssues(
  f: Pick<LaunchForm, "targetServerId" | "acmeEmail" | "observeMinutes"> & Partial<Pick<LaunchForm, "placement" | "campaign" | "sourceRunner" | "hostLoop" | "deployConcurrency" | "policies">>,
): LaunchIssue[] {
  const out: LaunchIssue[] = [];
  if (!f.targetServerId) out.push("target");
  if (f.acmeEmail.trim() && !looksLikeEmail(f.acmeEmail)) out.push("email");
  const n = Number(f.observeMinutes);
  if (f.observeMinutes.trim() === "" || !Number.isInteger(n) || n < 0 || n > 4320) out.push("observe");
  if (f.placement) {
    const entries = Object.entries(f.placement);
    if (entries.length === 0 || entries.length > SERVER_MAP_MAX || entries.some(([, id]) => !id)) out.push("placement");
  }
  if (f.campaign !== undefined && f.campaign.trim() !== "" && !validCampaign(f.campaign)) out.push("campaign");
  if (f.sourceRunner === "coolify-host-loop" && f.hostLoop) {
    const h = f.hostLoop;
    if (!validKeyDir(h.keyDir.trim()) || !intIn(h.parallel, 1, 8) || !intIn(h.connectTimeoutSec, 5, 120) || !intIn(h.retries, 0, 5)) out.push("hostLoop");
  }
  if (f.deployConcurrency !== undefined && f.deployConcurrency.trim() !== "" && !intIn(f.deployConcurrency, 1, 8)) out.push("concurrency");
  return out;
}

/** The policy inputs that were answered, as the request form (an unanswered one is left out: the hub's safe default applies). */
export function policyInputs(p: LaunchPolicies | undefined): NonNullable<MigrationRunCreateInput["inputs"]> {
  if (!p) return {};
  return {
    ...(p.minioPolicy ? { minioPolicy: p.minioPolicy as "hold" | "mirror" | "external" } : {}),
    ...(p.workerPolicy ? { workerPolicy: p.workerPolicy as "hold-dark" | "start-dark" | "exclude" } : {}),
    ...(p.unlistedDbPolicy ? { unlistedDbPolicy: p.unlistedDbPolicy as "block" | "carry" | "skip" } : {}),
    ...(p.orphanVolumePolicy ? { orphanVolumePolicy: p.orphanVolumePolicy as "block" | "skip" } : {}),
  };
}

/** The `POST /migration-runs` body. An unanswered ACME email is sent as "unknown" (blocks only TLS and CUTOVER). The
 *  plan step's acks / service choices / data modes ride along so the run's frozen apply input equals what was reviewed.
 *  A placement (multi-host) is sent as the run-level `serverMap`; the form's target server stays the default. */
export function buildLaunchInput(f: LaunchForm): MigrationRunCreateInput {
  const e = f.extras ?? {};
  const hostLoop =
    f.sourceRunner === "coolify-host-loop" && f.hostLoop
      ? { keyDir: f.hostLoop.keyDir.trim(), parallel: Number(f.hostLoop.parallel), connectTimeoutSec: Number(f.hostLoop.connectTimeoutSec), retries: Number(f.hostLoop.retries) }
      : undefined;
  const options: Partial<MigrationRunOptions> = {
    ...(f.options ?? {}),
    observeMinutes: Number(f.observeMinutes),
    ...(f.sourceRunner && f.sourceRunner !== "operator" ? { sourceRunner: f.sourceRunner } : {}),
    ...(hostLoop ? { hostLoop } : {}),
    ...(f.deployWaves && f.deployWaves !== "single" ? { deployWaves: f.deployWaves } : {}),
    ...(f.deployConcurrency?.trim() ? { deployConcurrency: Number(f.deployConcurrency) } : {}),
    ...(f.largeDbMode && f.largeDbMode !== "refuse" ? { largeDbMode: f.largeDbMode } : {}),
    ...(f.stopSource ? { stopSource: true } : {}),
  };
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
    options,
    inputs: {
      acmeEmail: f.acmeEmail.trim() ? f.acmeEmail.trim() : "unknown",
      allowBind: f.allowBind,
      allowLiveShapeProbe: f.allowLiveShapeProbe,
      sourceController: f.sourceController,
      ...policyInputs(f.policies),
    },
    ...(f.placement && Object.keys(f.placement).length ? { serverMap: f.placement } : {}),
    ...(f.campaign?.trim() ? { campaign: f.campaign.trim() } : {}),
  };
}

/** "Source host -> target server" label of a run row (names only; a deleted server reads as its id). */
export function runTitleParts(r: Pick<MigrationRunSummary, "sourceHost" | "sourceKind" | "targetServerName" | "targetServerId"> & Partial<Pick<MigrationRunSummary, "targetServerCount">>): { source: string; target: string; extraTargets: number } {
  return { source: r.sourceHost ?? r.sourceKind, target: r.targetServerName ?? r.targetServerId, extraTargets: Math.max(0, (r.targetServerCount ?? 1) - 1) };
}

/** Image digest as the hub accepts it: `sha256:` and 64 lower-case hex characters. */
export const validDigest = (v: string): boolean => /^sha256:[a-f0-9]{64}$/.test(v.trim());
/** An image reference as the plan shows it (the hub's own rule). */
export const validImageRef = (v: string): boolean => v.length >= 1 && v.length <= 300 && /^[A-Za-z0-9][A-Za-z0-9._\/:-]*$/.test(v);
/** A source host ref for an image pin scope: empty means every host. */
export const validPinScope = (v: string): boolean => v.length <= 200 && /^[\x21-\x7e]*$/.test(v);
/** The plan item ref of an app (`app:<host>:<ref>`). */
export const validAppItemRef = (v: string): boolean => /^app:[\x21-\x7e]{1,200}:[\x21-\x7e]{1,130}$/.test(v) && v.length <= 340;
/** Runs that can no longer take safety facts (finished, or past the point of no return). */
export const hintsClosed = (run: Pick<MigrationRunView, "status" | "ponrAt">): boolean =>
  !!run.ponrAt || ["COMPLETED", "ABORTED", "ROLLING_BACK", "ROLLED_BACK", "REVERSING", "REVERSED"].includes(run.status);

export interface CampaignRollup {
  campaign: string;
  total: number;
  completed: number;
  live: number;
  failed: number;
  /** Dry runs and runs that were aborted, rolled back or reversed: settled, but not a migration that completed. */
  other: number;
}
/** How many runs the roll-up asks the hub for; a list this long may be cut off, so its counts are then a lower bound. */
export const CAMPAIGN_ROLLUP_LIMIT = 200;

/** The distinct campaign labels of a list of runs with how many runs each holds, split into completed / live / failed /
 *  other (dry-run or stopped), so the parts always add up to the total. Feed it the UNFILTERED runs, never a filtered page. */
export function campaignRollup(rows: ReadonlyArray<Pick<MigrationRunSummary, "campaign" | "status">>): CampaignRollup[] {
  const by = new Map<string, CampaignRollup>();
  for (const r of rows) {
    if (!r.campaign) continue;
    const row = by.get(r.campaign) ?? { campaign: r.campaign, total: 0, completed: 0, live: 0, failed: 0, other: 0 };
    row.total += 1;
    if (r.status === "COMPLETED") row.completed += 1;
    else if (r.status === "FAILED") row.failed += 1;
    else if (isTerminalRun(r.status)) row.other += 1;
    else row.live += 1;
    by.set(r.campaign, row);
  }
  return [...by.values()].sort((a, b) => (a.campaign < b.campaign ? -1 : a.campaign > b.campaign ? 1 : 0));
}

// ───────────────────────────── campaign report (R15/R69) ─────────────────────────────

/** The campaign report reads the final report of at most this many runs (one request each); a campaign is a few runs to a few dozen. */
export const CAMPAIGN_REPORT_RUN_CAP = 60;

export interface CampaignRunRow {
  id: string;
  status: MigrationRunStatus;
  currentStep: MigrationRunStepKey | null;
  mode: MigrationRunMode;
  topology: MigrationRunTopology;
  dryRun: boolean;
  sourceHost: string | null;
  /** The target servers' names (the run's report lists them all); the default server alone until the report is loaded. */
  targetNames: string[];
  targetCount: number;
  estimatedSec: number | null;
  measuredSec: number | null;
  /** What the run's report counted per outcome; null until the report is loaded (or when it could not be read). */
  items: { moved: number; skipped: number; acked: number; failed: number; notCutOver: number } | null;
  /** The code the run itself failed with. */
  failure: { step: MigrationRunStepKey | null; code: string } | null;
  /** The items that failed or were not cut over, with the code that says why (at most 20 per run). */
  problemItems: Array<{ kind: string; name: string; outcome: "failed" | "not-cut-over"; code: string | null }>;
  createdAt: string;
}

export interface CampaignReportData {
  campaign: string;
  runs: CampaignRunRow[];
  rollup: Omit<CampaignRollup, "campaign">;
  /** Items over the runs whose report is loaded. */
  totals: { moved: number; skipped: number; acked: number; failed: number; notCutOver: number };
  window: {
    /** Sum of the measured windows (each run's own downtime) and the longest one; null while no run has one. */
    measuredTotalSec: number | null;
    measuredLongestSec: number | null;
    estimatedTotalSec: number | null;
  };
  /** Distinct source hosts and target servers across the runs. */
  sourceHosts: string[];
  targetServers: string[];
  /** Runs whose report is not loaded yet. */
  pendingReports: number;
}

const PROBLEM_ITEM_CAP = 20;

/** Every run of one campaign rolled up: per run its state, hosts, window and failures, plus the totals. `reports` maps a run id
 *  to its final report (`undefined` = not loaded yet, `null` = could not be read); a run without one still has its row. */
export function buildCampaignReport(
  campaign: string,
  runs: ReadonlyArray<MigrationRunSummary>,
  reports: ReadonlyMap<string, MigrationRunReport | null | undefined>,
): CampaignReportData {
  const mine = runs.filter((r) => r.campaign === campaign).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  const rows: CampaignRunRow[] = mine.map((r) => {
    const rep = reports.get(r.id) ?? null;
    const items = rep ? { moved: 0, skipped: 0, acked: 0, failed: 0, notCutOver: 0 } : null;
    const problems: CampaignRunRow["problemItems"] = [];
    for (const it of rep?.items ?? []) {
      if (it.outcome === "moved") items!.moved += 1;
      else if (it.outcome === "skipped") items!.skipped += 1;
      else if (it.outcome === "acked") items!.acked += 1;
      else if (it.outcome === "failed") items!.failed += 1;
      else items!.notCutOver += 1;
      if ((it.outcome === "failed" || it.outcome === "not-cut-over") && problems.length < PROBLEM_ITEM_CAP) problems.push({ kind: it.kind, name: it.name, outcome: it.outcome, code: it.code });
    }
    const named = (rep?.targets ?? []).map((t) => t.serverName ?? t.serverId);
    return {
      id: r.id,
      status: r.status,
      currentStep: r.currentStep,
      mode: r.mode,
      topology: r.topology,
      dryRun: r.dryRun,
      sourceHost: r.sourceHost,
      targetNames: named.length > 0 ? named : [r.targetServerName ?? r.targetServerId],
      targetCount: Math.max(r.targetServerCount, named.length),
      estimatedSec: rep?.window.estimatedSec ?? null,
      measuredSec: rep?.window.measuredSec ?? null,
      items,
      failure: r.failure,
      problemItems: problems,
      createdAt: r.createdAt,
    };
  });
  const roll = campaignRollup(mine)[0];
  const rollup = roll ? { total: roll.total, completed: roll.completed, live: roll.live, failed: roll.failed, other: roll.other } : { total: 0, completed: 0, live: 0, failed: 0, other: 0 };
  const totals = { moved: 0, skipped: 0, acked: 0, failed: 0, notCutOver: 0 };
  for (const r of rows) if (r.items) for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += r.items[k];
  const measured = rows.map((r) => r.measuredSec).filter((n): n is number => n !== null);
  const estimated = rows.map((r) => r.estimatedSec).filter((n): n is number => n !== null);
  const distinct = (xs: ReadonlyArray<string | null>) => [...new Set(xs.filter((x): x is string => !!x))].sort();
  return {
    campaign,
    runs: rows,
    rollup,
    totals,
    window: {
      measuredTotalSec: measured.length ? measured.reduce((a, b) => a + b, 0) : null,
      measuredLongestSec: measured.length ? Math.max(...measured) : null,
      estimatedTotalSec: estimated.length ? estimated.reduce((a, b) => a + b, 0) : null,
    },
    sourceHosts: distinct(rows.map((r) => r.sourceHost)),
    targetServers: distinct(rows.flatMap((r) => r.targetNames)),
    pendingReports: rows.filter((r) => reports.get(r.id) === undefined).length,
  };
}

/** The panel link of a campaign's report. */
export const campaignReportHref = (campaign: string): string => `/import/runs/campaign?c=${encodeURIComponent(campaign)}`;

// ───────────────────────────── errors ─────────────────────────────

/** Stable machine codes the hub puts in an error message (contract: 409 approval-stale / run-past-ponr, 403
 *  human-confirmation-required). A literal map so the key test sees them. */
export const ERROR_CODE_KEY: Record<string, string> = {
  "approval-stale": "migrationRun.errors.approval-stale",
  "run-past-ponr": "migrationRun.errors.run-past-ponr",
  "human-confirmation-required": "migrationRun.errors.human-confirmation-required",
  "attest-subject-invalid": "migrationRun.errors.attest-subject-invalid",
  "attest-note-required": "migrationRun.errors.attest-note-required",
  "command-kind-unavailable": "migrationRun.errors.command-kind-unavailable",
  "hints-closed": "migrationRun.errors.hints-closed",
  "server-has-live-run": "migrationRun.errors.server-has-live-run",
};

/** An error from the hub as one readable line: a known machine code is localized, anything else is the hub's message. */
export function errorText(t: T, e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  for (const [code, key] of Object.entries(ERROR_CODE_KEY)) if (msg.includes(code)) return t(key);
  return msg || t("migrationRun.errors.generic");
}

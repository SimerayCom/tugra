/**
 * Secret-free views of a run (P7 lane A): the full {@link MigrationRunView}, the list summary and the final report.
 * Everything is derived from the rows; the output carries codes + params only (never English text, never a source value),
 * so the web localizes it and nothing sensitive can leak through a view.
 */
import {
  OwnerInputsSchema,
  RunOptionsSchema,
  WindowEstimateSchema,
  type CodeParams,
  type GateResult,
  type MigrationRunStepView,
  type MigrationRunSummary,
  type MigrationRunView,
  type RunReport,
  type StepApprovalRecord,
  type StepEvidence,
  type WaitSpec,
} from "./dto";
import { EMPTY_STEP_EVIDENCE, isRunCode, type EvidenceKind, type RunMode, type RunStatus, type RunTopology, type StepKey, type StepKind, type StepStatus, type RollbackClass } from "./run-contract";
import { deriveNextAction, deriveRunAllowed, deriveStepAllowed, flowKeys, measuredDowntimeSec, stripSince, type RunFacts, type StepFacts } from "./run-logic";
import type { RunRow, StepRow } from "./run-store";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const code = (s: string | null): string | null => (s && isRunCode(s) ? s : null);

export function runFacts(r: RunRow): RunFacts {
  return {
    status: r.status as RunStatus,
    mode: r.mode as RunMode,
    dryRun: r.dryRun,
    ponrAt: r.ponrAt,
    pauseRequested: r.pauseRequested,
    opId: r.opId,
    opHistory: r.opHistory,
    failureStep: (r.failureStep as StepKey | null) ?? null,
    failureCode: r.failureCode,
    currentStep: (r.currentStep as StepKey | null) ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

export function stepFacts(s: StepRow): StepFacts {
  const ev = (s.evidence as StepEvidence | null) ?? EMPTY_STEP_EVIDENCE;
  return {
    key: s.key as StepKey,
    status: s.status as StepStatus,
    gate: (s.gate as GateResult | null) ?? null,
    wait: (s.wait as StepFacts["wait"]) ?? null,
    lastError: s.lastError,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    evidenceAttachments: ev.attachments.length,
  };
}

const factsMap = (rows: readonly StepRow[]): Map<StepKey, StepFacts> => new Map(rows.map((s) => [s.key as StepKey, stepFacts(s)]));

function stepView(run: RunFacts, s: StepRow, facts: StepFacts): MigrationRunStepView {
  const approval = (s.approval as StepApprovalRecord | null) ?? null;
  const { confirmedName: _typed, ...approvalView } = approval ?? ({} as StepApprovalRecord);
  void _typed;
  const wait = s.wait ? (stripSince(s.wait as object) as WaitSpec) : null;
  const status = s.status as StepStatus;
  return {
    key: s.key as StepKey,
    idx: s.idx,
    kind: s.kind as StepKind,
    status,
    rollbackClass: s.rollbackClass as RollbackClass,
    attempt: s.attempt,
    skippedCode: status === "SKIPPED" ? code(s.lastError) : null,
    gate: (s.gate as GateResult | null) ?? null,
    approval: approval ? approvalView : null,
    wait,
    progress: (s.progress as MigrationRunStepView["progress"]) ?? null,
    evidence: (s.evidence as StepEvidence | null) ?? EMPTY_STEP_EVIDENCE,
    notBefore: iso(s.notBefore),
    startedAt: iso(s.startedAt),
    finishedAt: iso(s.finishedAt),
    lastError: status === "FAILED" ? code(s.lastError) : null,
    allowed: deriveStepAllowed(run, facts),
  };
}

export function toView(r: RunRow, steps: readonly StepRow[], serverName: string | null): MigrationRunView {
  const facts = runFacts(r);
  const fm = factsMap(steps);
  const failureCode = code(r.failureCode);
  const sorted = [...steps].sort((a, b) => a.idx - b.idx);
  return {
    id: r.id,
    teamId: r.teamId,
    actorId: r.actorId,
    targetServerId: r.targetServerId,
    targetServerName: serverName,
    sourceKind: r.sourceKind as MigrationRunView["sourceKind"],
    sourceHost: r.sourceHost,
    opId: r.opId,
    opHistory: [...r.opHistory],
    planHash: r.planHash,
    mode: r.mode as RunMode,
    topology: r.topology as RunTopology,
    dryRun: r.dryRun,
    promotedFromId: r.promotedFromId,
    status: r.status as RunStatus,
    currentStep: (r.currentStep as StepKey | null) ?? null,
    ponrAt: iso(r.ponrAt),
    pauseRequested: r.pauseRequested,
    abortRequested: r.abortRequested,
    options: RunOptionsSchema.parse(r.options),
    inputs: OwnerInputsSchema.parse(r.inputs ?? {}),
    windowEstimate: r.windowEstimate ? WindowEstimateSchema.parse(r.windowEstimate) : null,
    freezeStartedAt: iso(r.freezeStartedAt),
    freezeEndedAt: iso(r.freezeEndedAt),
    measuredDowntimeSec: measuredDowntimeSec(r.freezeStartedAt, r.freezeEndedAt),
    failure: failureCode ? { step: (r.failureStep as StepKey | null) ?? null, code: failureCode } : null,
    nextAction: deriveNextAction(facts, fm),
    allowed: deriveRunAllowed(facts, fm),
    steps: sorted.map((s) => stepView(facts, s, fm.get(s.key as StepKey)!)),
    eventSeq: r.eventSeq,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toSummary(r: RunRow, steps: readonly StepRow[], serverName: string | null): MigrationRunSummary {
  const fm = factsMap(steps);
  const failureCode = code(r.failureCode);
  const flow = new Set<string>(flowKeys(r.mode as RunMode));
  const mine = steps.filter((s) => flow.has(s.key));
  return {
    id: r.id,
    teamId: r.teamId,
    targetServerId: r.targetServerId,
    targetServerName: serverName,
    sourceKind: r.sourceKind as MigrationRunSummary["sourceKind"],
    sourceHost: r.sourceHost,
    mode: r.mode as RunMode,
    topology: r.topology as RunTopology,
    dryRun: r.dryRun,
    status: r.status as RunStatus,
    currentStep: (r.currentStep as StepKey | null) ?? null,
    ponrAt: iso(r.ponrAt),
    stepsPassed: mine.filter((s) => s.status === "PASSED" || s.status === "SKIPPED").length,
    stepsTotal: mine.length,
    nextActionKind: deriveNextAction(runFacts(r), fm).kind,
    failure: failureCode ? { step: (r.failureStep as StepKey | null) ?? null, code: failureCode } : null,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
  };
}

// ───────────────────────────── report ─────────────────────────────

export type ReportItem = RunReport["items"][number];

/** The operator actions a compensation could not do itself (kept in `MigrationRun.report.manual`). */
export function manualOf(r: RunRow): Array<{ code: string; params?: CodeParams }> {
  const rep = r.report as { manual?: unknown } | null;
  if (!rep || !Array.isArray(rep.manual)) return [];
  return rep.manual.filter((m): m is { code: string; params?: CodeParams } => !!m && typeof (m as { code?: unknown }).code === "string" && isRunCode((m as { code: string }).code));
}

/** Count the passed gate checks of every step by how trustworthy their evidence is. */
export function evidenceSummary(steps: readonly StepRow[]): RunReport["evidenceSummary"] {
  const out: Record<EvidenceKind, number> = { "hub-verified": 0, "migrator-reported": 0, "operator-attested": 0 };
  for (const s of steps) {
    const g = s.gate as GateResult | null;
    for (const c of g?.checks ?? []) if ((c.status === "pass" || c.acked === true) && c.evidence) out[c.evidence] += 1;
  }
  return out;
}

export function buildReport(r: RunRow, steps: readonly StepRow[], items: readonly ReportItem[], serverName: string | null, now: Date): RunReport {
  const est = r.windowEstimate ? WindowEstimateSchema.parse(r.windowEstimate) : null;
  return {
    runId: r.id,
    generatedAt: now.toISOString(),
    status: r.status as RunStatus,
    mode: r.mode as RunMode,
    topology: r.topology as RunTopology,
    dryRun: r.dryRun,
    source: { kind: r.sourceKind as RunReport["source"]["kind"], host: r.sourceHost },
    target: { serverId: r.targetServerId, serverName },
    ponrAt: iso(r.ponrAt),
    window: { estimatedSec: est?.freezeToFlipSec ?? null, measuredSec: measuredDowntimeSec(r.freezeStartedAt, r.freezeEndedAt) },
    steps: [...steps]
      .sort((a, b) => a.idx - b.idx)
      .map((s) => ({
        key: s.key as StepKey,
        status: s.status as StepStatus,
        attempts: s.attempt,
        durationSec: s.startedAt && s.finishedAt ? Math.max(0, Math.round((s.finishedAt.getTime() - s.startedAt.getTime()) / 1000)) : null,
        code: code(s.lastError),
      })),
    items: items.slice(0, 5000).map((i) => ({ ...i })),
    evidenceSummary: evidenceSummary(steps),
    manual: manualOf(r).map((m) => ({ code: m.code, ...(m.params ? { params: m.params } : {}) })),
  };
}

const fmtParams = (p?: CodeParams): string => (p && Object.keys(p).length ? ` (${Object.entries(p).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`).join(", ")})` : "");
const mdCell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** Markdown rendering of the report. Codes are printed as their stable identifier (the web maps them to the English locale). */
export function reportToMarkdown(rep: RunReport): string {
  const L: string[] = [];
  L.push(`# Migration run ${rep.runId}`, "");
  L.push(`- Status: ${rep.status}${rep.dryRun ? " (dry-run)" : ""}`);
  L.push(`- Mode: ${rep.mode}, topology: ${rep.topology}`);
  L.push(`- Source: ${rep.source.kind}${rep.source.host ? ` (${rep.source.host})` : ""}`);
  L.push(`- Target server: ${rep.target.serverName ?? rep.target.serverId}`);
  if (rep.ponrAt) L.push(`- Point of no return: ${rep.ponrAt}`);
  L.push(`- Downtime window: estimated ${rep.window.estimatedSec ?? "n/a"} s, measured ${rep.window.measuredSec ?? "n/a"} s`);
  L.push("", "## Steps", "", "| Step | Status | Attempts | Seconds | Code |", "| --- | --- | --- | --- | --- |");
  for (const s of rep.steps) L.push(`| ${s.key} | ${s.status} | ${s.attempts} | ${s.durationSec ?? ""} | ${s.code ?? ""} |`);
  L.push("", "## Items", "");
  if (!rep.items.length) L.push("No items recorded.");
  else {
    L.push("| Kind | Name | Outcome | Code | Evidence |", "| --- | --- | --- | --- | --- |");
    for (const i of rep.items) L.push(`| ${i.kind} | ${mdCell(i.name)} | ${i.outcome} | ${i.code ?? ""} | ${i.evidence ?? ""} |`);
  }
  L.push("", "## Evidence", "");
  for (const [k, v] of Object.entries(rep.evidenceSummary)) L.push(`- ${k}: ${v}`);
  if (rep.manual.length) {
    L.push("", "## Operator actions still required", "");
    for (const m of rep.manual) L.push(`- ${m.code}${fmtParams(m.params)}`);
  }
  return `${L.join("\n")}\n`;
}

import { MIGRATION_RUN_STEP_KEYS } from "../../lib/migration-run";
import type { MigrationRunApprovalBinding, MigrationRunStepKey, MigrationRunStepStatus, MigrationRunStepView, MigrationRunSummary, MigrationRunView } from "../../lib/types";

export const HASH = "c".repeat(64);
export const HASH2 = "d".repeat(64);

export const binding = (over: Partial<MigrationRunApprovalBinding> = {}): MigrationRunApprovalBinding => ({
  inputHash: HASH, ponr: false, confirm: "none", ttlSec: null, requiresDataRisk: false, ackable: [], requiredAcks: [], review: {}, ...over,
});

export const mkStep = (key: MigrationRunStepKey, status: MigrationRunStepStatus = "PENDING", over: Partial<MigrationRunStepView> = {}): MigrationRunStepView => ({
  key, idx: MIGRATION_RUN_STEP_KEYS.indexOf(key), kind: "auto", status, rollbackClass: "FREE", attempt: 0, skippedCode: null, gate: null, approval: null, wait: null, progress: null,
  evidence: { attestations: [], attachments: [] }, notBefore: null, startedAt: null, finishedAt: null, lastError: null,
  allowed: { approve: false, retry: false, skip: false, evidence: false, attach: false, command: false }, ...over,
});

const FLOW: MigrationRunStepKey[] = MIGRATION_RUN_STEP_KEYS.filter((k) => k !== "DECOMMISSION");

export const mkRun = (over: Partial<MigrationRunView> = {}, steps?: MigrationRunStepView[]): MigrationRunView => ({
  id: "run12345abcdef",
  teamId: "t1",
  actorId: "u1",
  targetServerId: "srv1",
  targetServerName: "tugra-1",
  serverMap: {},
  targetServers: [{ serverId: "srv1", serverName: "tugra-1", primary: true }],
  sourceKind: "coolify",
  sourceHost: "coolify.example.org",
  sourceVersion: "4.5.0",
  sourceVersionVerdict: "supported",
  campaign: null,
  baselineAt: null,
  opId: null,
  opHistory: [],
  planHash: "a".repeat(32),
  mode: "copy",
  topology: "two-box",
  dryRun: false,
  promotedFromId: null,
  status: "WAITING",
  currentStep: "VERIFY",
  ponrAt: null,
  pauseRequested: false,
  abortRequested: false,
  options: {
    ttlPolicy: "wait", deployWaves: "single", warmDbSeed: false, stopSource: false, sourceRunner: "operator", certs: "none", acceptHttp01Gap: false, observeMinutes: 30, manualFinalize: false,
    batchSize: 5, intervalSec: 30, rowCountMode: "estimate", decommissionMinAgeHours: 72, stuckOperatorMinutes: 60,
  },
  inputs: {},
  windowEstimate: null,
  freezeStartedAt: null,
  freezeEndedAt: null,
  measuredDowntimeSec: null,
  failure: null,
  nextAction: { kind: "engine", stepKey: null, code: "run.started", since: "2026-11-16T10:00:00.000Z" },
  allowed: { start: false, pause: true, resume: false, abort: true, cleanup: false, reverse: false, decommission: false, setInputs: true, sourceSession: false },
  steps: steps ?? FLOW.map((k) => mkStep(k, k === "PREFLIGHT" || k === "IMPORT" ? "PASSED" : "PENDING")),
  eventSeq: 0,
  createdAt: "2026-11-16T09:00:00.000Z",
  startedAt: "2026-11-16T09:01:00.000Z",
  finishedAt: null,
  updatedAt: "2026-11-16T10:00:00.000Z",
  ...over,
});

export const mkSummary = (over: Partial<MigrationRunSummary> = {}): MigrationRunSummary => ({
  id: "run12345abcdef", teamId: "t1", targetServerId: "srv1", targetServerName: "tugra-1", targetServerCount: 1, sourceKind: "coolify", sourceHost: "coolify.example.org", sourceVersion: "4.5.0", campaign: null, mode: "copy", topology: "two-box", dryRun: false,
  status: "RUNNING", currentStep: "IMPORT", ponrAt: null, stepsPassed: 1, stepsTotal: 13, nextActionKind: "engine", failure: null, createdAt: "2026-11-16T09:00:00.000Z", startedAt: "2026-11-16T09:01:00.000Z", finishedAt: null, ...over,
});

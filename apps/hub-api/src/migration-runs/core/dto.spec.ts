import {
  AbortRunSchema,
  ApprovalBindingSchema,
  AttachSchema,
  CleanupRunSchema,
  CreateMigrationRunSchema,
  DecommissionRunSchema,
  GateResultSchema,
  ListMigrationRunsQuerySchema,
  MigrationRunStepViewSchema,
  MigrationRunViewSchema,
  OwnerInputsSchema,
  ReverseRunSchema,
  RunApplyInputSchema,
  RunCommandSchema,
  RunEventsQuerySchema,
  RunOptionsSchema,
  RunReportQuerySchema,
  RunReportSchema,
  SetRunInputsSchema,
  SourceSessionSchema,
  StartRunSchema,
  StepApproveSchema,
  StepEvidenceInputSchema,
  StepRetrySchema,
  StepSkipSchema,
  WaitSpecSchema,
} from "./dto";
import { DEFAULT_DECOMMISSION_MIN_AGE_HOURS, DEFAULT_OBSERVE_MINUTES, STEP_KEYS, STEP_MANIFEST } from "./run-contract";

const H32 = "a".repeat(32);
const H64 = "b".repeat(64);
const NOW = "2026-11-23T10:00:00.000Z";
const base = { sessionId: "sess1", sourceKind: "coolify", targetServerId: "srv1", planHash: H32 };

describe("CreateMigrationRunSchema", () => {
  it("accepts the minimal body and applies the safe defaults", () => {
    const v = CreateMigrationRunSchema.parse(base);
    expect(v.mode).toBe("copy");
    expect(v.topology).toBe("two-box");
    expect(v.dryRun).toBe(false);
    expect(v.inputs).toEqual({});
    expect(v.options).toEqual(RunOptionsSchema.parse({}));
  });
  it("requires session, source, target and a 32-hex planHash", () => {
    for (const k of ["sessionId", "sourceKind", "targetServerId", "planHash"] as const) {
      const { [k]: _omit, ...rest } = base;
      expect(CreateMigrationRunSchema.safeParse(rest).success).toBe(false);
    }
    expect(CreateMigrationRunSchema.safeParse({ ...base, planHash: "short" }).success).toBe(false);
    expect(CreateMigrationRunSchema.safeParse({ ...base, planHash: "A".repeat(32) }).success).toBe(false);
  });
  it("only remote sources (coolify, dokploy); local-docker adopts in place and has no run", () => {
    expect(CreateMigrationRunSchema.safeParse({ ...base, sourceKind: "dokploy" }).success).toBe(true);
    expect(CreateMigrationRunSchema.safeParse({ ...base, sourceKind: "local-docker" }).success).toBe(false);
  });
  it("mode and topology are enums; side-by-side is rejected (not available in v1)", () => {
    expect(CreateMigrationRunSchema.safeParse({ ...base, mode: "takeover", topology: "swap-proxy" }).success).toBe(true);
    expect(CreateMigrationRunSchema.safeParse({ ...base, topology: "side-by-side" }).success).toBe(false);
    expect(CreateMigrationRunSchema.safeParse({ ...base, mode: "move" }).success).toBe(false);
  });
  it("mapping and mappingHash travel together", () => {
    expect(CreateMigrationRunSchema.safeParse({ ...base, mappingHash: H32 }).success).toBe(false);
  });
  it("is strict: no unknown keys (the source token can never ride the body)", () => {
    expect(CreateMigrationRunSchema.safeParse({ ...base, token: "secret" }).success).toBe(false);
    expect(CreateMigrationRunSchema.safeParse({ ...base, options: { nope: 1 } }).success).toBe(false);
  });
  it("carries owner inputs as bare values, incl. the literal unknown", () => {
    const v = CreateMigrationRunSchema.parse({ ...base, inputs: { acmeEmail: "ops@example.com", allowBind: "unknown", sourceController: "agent" } });
    expect(v.inputs).toEqual({ acmeEmail: "ops@example.com", allowBind: "unknown", sourceController: "agent" });
    expect(CreateMigrationRunSchema.safeParse({ ...base, inputs: { acmeEmail: "not-an-email" } }).success).toBe(false);
    expect(CreateMigrationRunSchema.safeParse({ ...base, inputs: { sourceController: "ssh" } }).success).toBe(false);
  });
  it("accepts importer acks and service choices with the importer's own vocabulary", () => {
    expect(CreateMigrationRunSchema.safeParse({ ...base, acks: [{ code: "app.env.unresolved" }] }).success).toBe(true);
    expect(CreateMigrationRunSchema.safeParse({ ...base, acks: [{ code: "something.else" }] }).success).toBe(false);
  });
});

describe("RunApplyInputSchema (frozen, secret-free)", () => {
  it("has no session, no token and no run-level switches", () => {
    expect(RunApplyInputSchema.safeParse({ sourceKind: "coolify", targetServerId: "s", planHash: H32 }).success).toBe(true);
    expect(RunApplyInputSchema.safeParse({ sourceKind: "coolify", targetServerId: "s", planHash: H32, sessionId: "x" }).success).toBe(false);
    expect(RunApplyInputSchema.safeParse({ sourceKind: "coolify", targetServerId: "s", planHash: H32, mode: "copy" }).success).toBe(false);
  });
});

describe("RunOptionsSchema", () => {
  it("defaults to the conservative run", () => {
    expect(RunOptionsSchema.parse({})).toEqual({
      ttlPolicy: "wait",
      deployWaves: "single",
      warmDbSeed: false,
      stopSource: false,
      sourceRunner: "operator",
      certs: "none",
      acceptHttp01Gap: false,
      observeMinutes: DEFAULT_OBSERVE_MINUTES,
      manualFinalize: false,
      batchSize: 5,
      intervalSec: 30,
      rowCountMode: "estimate",
      decommissionMinAgeHours: DEFAULT_DECOMMISSION_MIN_AGE_HOURS,
      stuckOperatorMinutes: 60,
    });
  });
  it("bounds pacing, observe window and the probe path", () => {
    for (const bad of [{ batchSize: 0 }, { batchSize: 26 }, { intervalSec: 4 }, { observeMinutes: 4321 }, { observeMinutes: -1 }, { healthPath: "healthz" }, { healthPath: "/a b" }, { sourceRunner: "ssh" }]) {
      expect(RunOptionsSchema.safeParse(bad).success).toBe(false);
    }
    expect(RunOptionsSchema.safeParse({ observeMinutes: 0, healthPath: "/healthz", freezeAt: NOW }).success).toBe(true);
  });
});

describe("action bodies", () => {
  it("approve needs a 64-hex boundHash and defaults acks", () => {
    expect(StepApproveSchema.safeParse({}).success).toBe(false);
    expect(StepApproveSchema.safeParse({ boundHash: "x" }).success).toBe(false);
    expect(StepApproveSchema.parse({ boundHash: H64 }).acks).toEqual([]);
    expect(StepApproveSchema.safeParse({ boundHash: H64, confirmName: "srv-1", acceptDataRisk: true, acks: ["c1"] }).success).toBe(true);
  });
  it("abort / decommission need a typed name; reverse also the literal data-loss acknowledgement", () => {
    expect(AbortRunSchema.safeParse({}).success).toBe(false);
    expect(AbortRunSchema.safeParse({ confirmName: "run1" }).success).toBe(true);
    expect(DecommissionRunSchema.safeParse({ confirmName: "coolify.example.com" }).success).toBe(true);
    expect(ReverseRunSchema.safeParse({ confirmName: "run1" }).success).toBe(false);
    expect(ReverseRunSchema.safeParse({ confirmName: "run1", acknowledgeDataLoss: false }).success).toBe(false);
    expect(ReverseRunSchema.safeParse({ confirmName: "run1", acknowledgeDataLoss: true }).success).toBe(true);
  });
  it("cleanup defaults to no data removal", () => {
    expect(CleanupRunSchema.parse({ confirmName: "run1" })).toEqual({ confirmName: "run1", includeData: false, dataConfirmNames: [] });
  });
  it("empty-body actions are strict objects", () => {
    expect(StepRetrySchema.safeParse({}).success).toBe(true);
    expect(StepRetrySchema.safeParse({ force: true }).success).toBe(false);
    expect(StartRunSchema.safeParse({}).success).toBe(true);
    expect(StartRunSchema.safeParse({ sessionId: "s" }).success).toBe(true);
    expect(StepSkipSchema.safeParse({ reason: "x".repeat(301) }).success).toBe(false);
    expect(RunCommandSchema.parse({})).toEqual({ reissue: false });
  });
  it("attach only knows object migrations; evidence needs a check id", () => {
    expect(AttachSchema.safeParse({ kind: "object-migration", resourceId: "om1" }).success).toBe(true);
    expect(AttachSchema.safeParse({ kind: "server", resourceId: "x" }).success).toBe(false);
    expect(StepEvidenceInputSchema.safeParse({}).success).toBe(false);
    expect(StepEvidenceInputSchema.safeParse({ checkId: "freeze.source-quiesced", subject: "srv1" }).success).toBe(true);
  });
  it("owner inputs update needs at least one input", () => {
    expect(SetRunInputsSchema.safeParse({}).success).toBe(false);
    expect(SetRunInputsSchema.safeParse({ allowBind: true }).success).toBe(true);
  });
  it("source session takes a bounded token only", () => {
    expect(SourceSessionSchema.safeParse({ token: "t" }).success).toBe(true);
    expect(SourceSessionSchema.safeParse({ token: "" }).success).toBe(false);
    expect(SourceSessionSchema.safeParse({ token: "t", baseUrl: "https://x" }).success).toBe(false);
  });
});

describe("queries", () => {
  it("events: afterSeq defaults to 0, limit is bounded and strings are coerced", () => {
    expect(RunEventsQuerySchema.parse({})).toEqual({ afterSeq: 0, limit: 200 });
    expect(RunEventsQuerySchema.parse({ afterSeq: "42", limit: "10" })).toEqual({ afterSeq: 42, limit: 10 });
    expect(RunEventsQuerySchema.safeParse({ afterSeq: "-1" }).success).toBe(false);
    expect(RunEventsQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
  });
  it("list and report", () => {
    expect(ListMigrationRunsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(ListMigrationRunsQuerySchema.safeParse({ status: "NOPE" }).success).toBe(false);
    expect(ListMigrationRunsQuerySchema.parse({ active: "true", status: "WAITING", limit: "5" })).toEqual({ active: "true", status: "WAITING", limit: 5 });
    expect(RunReportQuerySchema.parse({})).toEqual({ format: "json" });
    expect(RunReportQuerySchema.safeParse({ format: "pdf" }).success).toBe(false);
  });
});

describe("persisted JSON shapes", () => {
  it("a gate result with a wait round-trips", () => {
    const g = { passed: false, checks: [{ id: "tls.acme-email", status: "unknown", code: "preflight.acme-email-unknown", ownerInput: "acmeEmail", evidence: "hub-verified" }], wait: { kind: "operator", code: "gate.blocked" } };
    expect(GateResultSchema.parse(g)).toEqual(g);
    expect(GateResultSchema.safeParse({ passed: true, checks: [{ id: "x", status: "maybe", code: "a.b" }] }).success).toBe(false);
    expect(GateResultSchema.safeParse({ passed: true, checks: [{ id: "x", status: "pass", code: "Not A Code" }] }).success).toBe(false);
  });
  it("wait specs are a discriminated union over operator / approval / timer", () => {
    const binding = { inputHash: H64, ponr: true, confirm: "target-server", ttlSec: 1800, requiresDataRisk: true, ackable: [], requiredAcks: [], review: { hosts: 3 } };
    expect(ApprovalBindingSchema.safeParse(binding).success).toBe(true);
    expect(WaitSpecSchema.safeParse({ kind: "approval", binding }).success).toBe(true);
    expect(WaitSpecSchema.safeParse({ kind: "timer", notBefore: NOW, code: "dns-prepare.ttl-wait" }).success).toBe(true);
    expect(WaitSpecSchema.safeParse({ kind: "operator", code: "data-final.run-migrator", offersCommand: true, attest: ["freeze.source-quiesced"] }).success).toBe(true);
    expect(WaitSpecSchema.safeParse({ kind: "timer", code: "x.y" }).success).toBe(false);
    expect(WaitSpecSchema.safeParse({ kind: "email", code: "x.y" }).success).toBe(false);
  });
  it("params are JSON-safe values only (no nested objects, no free text overflow)", () => {
    const ok = { kind: "operator", code: "a.b", params: { n: 1, s: "x", b: true, z: null, l: ["a", 2] } };
    expect(WaitSpecSchema.safeParse(ok).success).toBe(true);
    expect(WaitSpecSchema.safeParse({ kind: "operator", code: "a.b", params: { o: { nested: 1 } } }).success).toBe(false);
    expect(WaitSpecSchema.safeParse({ kind: "operator", code: "a.b", params: { s: "x".repeat(501) } }).success).toBe(false);
  });
  it("owner inputs with provenance", () => {
    expect(OwnerInputsSchema.safeParse({ acmeEmail: { value: "unknown", source: "default", setBy: null, at: NOW } }).success).toBe(true);
    expect(OwnerInputsSchema.safeParse({ allowBind: { value: "yes", source: "request", setBy: "u", at: NOW } }).success).toBe(false);
    expect(OwnerInputsSchema.safeParse({ extra: {} }).success).toBe(false);
  });
});

function stepView(key: (typeof STEP_KEYS)[number]) {
  const m = STEP_MANIFEST[key];
  return {
    key, idx: m.idx, kind: m.kind, status: "PENDING", rollbackClass: m.rollback, attempt: 0, skippedCode: null, gate: null, approval: null, wait: null, progress: null,
    evidence: { attestations: [], attachments: [] }, notBefore: null, startedAt: null, finishedAt: null, lastError: null,
    allowed: { approve: false, retry: false, skip: false, evidence: false, attach: false, command: false },
  };
}

describe("view schemas", () => {
  const view = {
    id: "r1", teamId: "t1", actorId: "u1", targetServerId: "s1", targetServerName: "tugra-1", sourceKind: "coolify", sourceHost: "coolify.example.com",
    opId: null, opHistory: [], planHash: H32, mode: "copy", topology: "two-box", dryRun: false, promotedFromId: null, status: "QUEUED", currentStep: null, ponrAt: null,
    pauseRequested: false, abortRequested: false, options: RunOptionsSchema.parse({}), inputs: {}, windowEstimate: null, freezeStartedAt: null, freezeEndedAt: null,
    measuredDowntimeSec: null, failure: null,
    nextAction: { kind: "none", stepKey: null, code: "run.queued", since: NOW },
    allowed: { start: true, pause: false, resume: false, abort: true, cleanup: false, reverse: false, decommission: false, setInputs: true, sourceSession: true },
    steps: STEP_KEYS.filter((k) => k !== "DECOMMISSION").map(stepView), eventSeq: 0, createdAt: NOW, startedAt: null, finishedAt: null, updatedAt: NOW,
  };
  it("a fresh run view parses", () => {
    expect(MigrationRunViewSchema.safeParse(view).success).toBe(true);
    expect(MigrationRunStepViewSchema.safeParse(stepView("FREEZE")).success).toBe(true);
  });
  it("the step view never carries the typed confirmation name", () => {
    const withName = { ...stepView("CUTOVER"), approval: { byUserId: "u1", at: NOW, boundHash: H64, acks: [], acceptDataRisk: true, expiresAt: null, confirmedName: "srv" } };
    const parsed = MigrationRunStepViewSchema.parse(withName);
    expect(parsed.approval).not.toHaveProperty("confirmedName");
  });
  it("the report is secret-free by shape: codes and counts only", () => {
    const rep = {
      runId: "r1", generatedAt: NOW, status: "COMPLETED", mode: "copy", topology: "two-box", dryRun: false, source: { kind: "coolify", host: null }, target: { serverId: "s1", serverName: null },
      ponrAt: NOW, window: { estimatedSec: 600, measuredSec: 540 }, steps: [], items: [{ kind: "app", name: "web", outcome: "moved", code: null, evidence: "hub-verified" }],
      evidenceSummary: { "hub-verified": 3, "migrator-reported": 1, "operator-attested": 0 }, manual: [],
    };
    expect(RunReportSchema.safeParse(rep).success).toBe(true);
    expect(RunReportSchema.safeParse({ ...rep, items: [{ kind: "token", name: "x", outcome: "moved", code: null, evidence: null }] }).success).toBe(false);
  });
});

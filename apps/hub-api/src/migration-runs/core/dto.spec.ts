import {
  AbortRunSchema,
  ApprovalBindingSchema,
  AttachSchema,
  CampaignSchema,
  CleanupRunSchema,
  CreateMigrationRunSchema,
  DecommissionRunSchema,
  GateResultSchema,
  HostLoopOptionsSchema,
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
  ServerMapSchema,
  SetRunInputsSchema,
  SourceBaselineSchema,
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
    id: "r1", teamId: "t1", actorId: "u1", targetServerId: "s1", targetServerName: "tugra-1", serverMap: {}, targetServers: [{ serverId: "s1", serverName: "tugra-1", primary: true }],
    sourceKind: "coolify", sourceHost: "coolify.example.com", sourceVersion: null, sourceVersionVerdict: "unknown", campaign: null, baselineAt: null,
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

describe("multi-host create (serverMap) and campaign", () => {
  it("serverMap and campaign are optional and absent by default", () => {
    const p = CreateMigrationRunSchema.parse(base);
    expect(p.serverMap).toBeUndefined();
    expect(p.campaign).toBeUndefined();
  });
  it("accepts a source-server to target-server map and a campaign label", () => {
    const p = CreateMigrationRunSchema.parse({ ...base, serverMap: { "src-a": "t1", "src-b": "t2", "src-c": "t1" }, campaign: "  team-3 wave  " });
    expect(p.serverMap).toEqual({ "src-a": "t1", "src-b": "t2", "src-c": "t1" });
    expect(p.campaign).toBe("team-3 wave");
  });
  it("rejects a bad map: empty target, reserved key, spaces in a key, too many entries", () => {
    expect(ServerMapSchema.safeParse({ a: "" }).success).toBe(false);
    expect(ServerMapSchema.safeParse({ a: "x".repeat(65) }).success).toBe(false);
    expect(ServerMapSchema.safeParse(JSON.parse('{"__proto__": "t1"}')).success).toBe(false);
    expect(ServerMapSchema.safeParse({ constructor: "t1" }).success).toBe(false);
    expect(ServerMapSchema.safeParse({ "has space": "t1" }).success).toBe(false);
    expect(ServerMapSchema.safeParse(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, "t1"]))).success).toBe(false);
    expect(ServerMapSchema.safeParse(Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`s${i}`, "t1"]))).success).toBe(true);
    expect(CreateMigrationRunSchema.safeParse({ ...base, serverMap: { a: 1 } }).success).toBe(false);
  });
  it("the campaign label is bounded printable text", () => {
    expect(CampaignSchema.safeParse("").success).toBe(false);
    expect(CampaignSchema.safeParse("x".repeat(81)).success).toBe(false);
    expect(CampaignSchema.safeParse("line\nbreak").success).toBe(false);
    expect(CampaignSchema.safeParse("wave 1 / team 3").success).toBe(true);
  });
  it("the serverMap is NOT part of the frozen apply input (it has its own column)", () => {
    expect(RunApplyInputSchema.safeParse({ sourceKind: "coolify", targetServerId: "s", planHash: H32, serverMap: { a: "t1" } }).success).toBe(false);
  });
  it("the list query filters by campaign", () => {
    expect(ListMigrationRunsQuerySchema.parse({ campaign: "wave-1" }).campaign).toBe("wave-1");
  });
});

describe("coolify-host-loop runner options", () => {
  it("the runner enum accepts coolify-host-loop; hostLoop is optional and strict", () => {
    expect(RunOptionsSchema.parse({ sourceRunner: "coolify-host-loop" }).sourceRunner).toBe("coolify-host-loop");
    expect(RunOptionsSchema.parse({}).hostLoop).toBeUndefined();
    expect(RunOptionsSchema.safeParse({ hostLoop: { privateKey: "x" } }).success).toBe(false);
  });
  it("fills the host-loop defaults and keeps keys out: a directory and numbers only", () => {
    expect(HostLoopOptionsSchema.parse({})).toEqual({ keyDir: "/data/coolify/ssh/keys", parallel: 1, connectTimeoutSec: 15, retries: 1 });
    expect(HostLoopOptionsSchema.parse({ keyDir: "/srv/keys", parallel: 4 })).toMatchObject({ keyDir: "/srv/keys", parallel: 4 });
  });
  it("refuses an unsafe key directory and out-of-range numbers", () => {
    for (const bad of [{ keyDir: "relative/dir" }, { keyDir: "/a b" }, { keyDir: "/a;rm -rf /" }, { keyDir: "/a/$(x)" }, { keyDir: "/a/../b" }, { keyDir: "/a`x`" }, { parallel: 0 }, { parallel: 9 }, { connectTimeoutSec: 4 }, { retries: 6 }]) {
      expect(HostLoopOptionsSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("new run options are optional (the default run is unchanged) and bounded", () => {
    expect(RunOptionsSchema.parse({}).deployConcurrency).toBeUndefined();
    expect(RunOptionsSchema.parse({}).largeDbMode).toBeUndefined();
    expect(RunOptionsSchema.parse({ deployWaves: "earlyBuild", deployConcurrency: 2, largeDbMode: "stream-logical" })).toMatchObject({ deployWaves: "earlyBuild", deployConcurrency: 2 });
    for (const bad of [{ deployConcurrency: 0 }, { deployConcurrency: 9 }, { largeDbMode: "magic" }, { deployWaves: "late" }]) expect(RunOptionsSchema.safeParse(bad).success).toBe(false);
  });
});

describe("grup-7 owner inputs", () => {
  const rec = (value: unknown) => ({ value, source: "request", setBy: "u1", at: NOW });
  it("stores the new inputs with provenance and accepts the literal unknown", () => {
    const p = OwnerInputsSchema.parse({ minioPolicy: rec("mirror"), tickGapAcceptMinutes: rec(30), workerPolicy: rec("exclude"), unlistedDbPolicy: rec("unknown"), orphanVolumePolicy: rec("skip") });
    expect(p.tickGapAcceptMinutes?.value).toBe(30);
    expect(p.unlistedDbPolicy?.value).toBe("unknown");
  });
  it("the request form takes bare values and bounds them", () => {
    expect(CreateMigrationRunSchema.safeParse({ ...base, inputs: { minioPolicy: "hold", tickGapAcceptMinutes: 0, workerPolicy: "hold-dark", unlistedDbPolicy: "carry", orphanVolumePolicy: "unknown" } }).success).toBe(true);
    for (const bad of [{ minioPolicy: "yes" }, { tickGapAcceptMinutes: -1 }, { tickGapAcceptMinutes: 10081 }, { tickGapAcceptMinutes: 1.5 }, { workerPolicy: "run" }, { unlistedDbPolicy: "drop" }, { orphanVolumePolicy: "carry" }]) {
      expect(SetRunInputsSchema.safeParse(bad).success).toBe(false);
    }
    expect(SetRunInputsSchema.safeParse({ tickGapAcceptMinutes: 90 }).success).toBe(true);
  });
});

describe("command kinds and the operator wait", () => {
  it("the command body takes an optional kind; the migrator stays the default", () => {
    expect(RunCommandSchema.parse({})).toEqual({ reissue: false });
    expect(RunCommandSchema.parse({ kind: "host-loop" }).kind).toBe("host-loop");
    expect(RunCommandSchema.safeParse({ kind: "shell" }).success).toBe(false);
  });
  it("an operator wait can name which command it offers", () => {
    expect(WaitSpecSchema.safeParse({ kind: "operator", code: "data-seed.waiting", offersCommand: true, commandKind: "host-loop" }).success).toBe(true);
    expect(WaitSpecSchema.safeParse({ kind: "operator", code: "data-seed.waiting", commandKind: "shell" }).success).toBe(false);
  });
  it("host-inventory is an attachable resource", () => {
    expect(AttachSchema.safeParse({ kind: "host-inventory", resourceId: "inv1" }).success).toBe(true);
  });
  it("the confirm kinds that name every target server are valid bindings", () => {
    for (const confirm of ["target-servers", "target-servers+source-host"]) {
      expect(ApprovalBindingSchema.safeParse({ inputHash: H64, ponr: true, confirm, ttlSec: 1800, requiresDataRisk: true, ackable: [], requiredAcks: [], review: {} }).success).toBe(true);
    }
  });
});

describe("source baseline", () => {
  it("is secret-free refs, health enums and counts", () => {
    const ok = { capturedAt: NOW, entries: [{ kind: "app", ref: "app-a", serverRef: "src-a", health: "unhealthy", restartCount: 126 }, { kind: "database", ref: "db-big", health: "unknown", restartCount: null }] };
    expect(SourceBaselineSchema.safeParse(ok).success).toBe(true);
    expect(SourceBaselineSchema.safeParse({ ...ok, entries: [{ kind: "app", ref: "a", health: "fine", restartCount: 0 }] }).success).toBe(false);
    expect(SourceBaselineSchema.safeParse({ ...ok, entries: [{ kind: "app", ref: "a", health: "healthy", restartCount: -1 }] }).success).toBe(false);
  });
});

describe("view and report additions", () => {
  const rep = {
    runId: "r1", generatedAt: NOW, status: "COMPLETED", mode: "copy", topology: "two-box", dryRun: false, source: { kind: "coolify", host: null }, target: { serverId: "s1", serverName: null },
    ponrAt: null, window: { estimatedSec: null, measuredSec: null }, steps: [], items: [], evidenceSummary: { "hub-verified": 0, "migrator-reported": 0, "operator-attested": 0 }, manual: [],
  };
  it("a report stored before grup-7 still parses, with the new fields defaulted", () => {
    const p = RunReportSchema.parse(rep);
    expect(p.targets).toEqual([]);
    expect(p.campaign).toBeNull();
    expect(p.source.version).toBeNull();
    expect(p.evidenceSummary["host-loop-reported"]).toBe(0);
    expect(p.evidenceSummary["source-api-reported"]).toBe(0);
  });
  it("a multi-host report lists every target server", () => {
    const p = RunReportSchema.parse({ ...rep, targets: [{ serverId: "s1", serverName: "host-1" }, { serverId: "s2", serverName: null }], campaign: "wave-1", source: { kind: "coolify", host: "src.example.test", version: "4.1.2" } });
    expect(p.targets).toHaveLength(2);
  });
  it("the view carries the placement and the source version", () => {
    expect(MigrationRunViewSchema.shape.serverMap).toBeDefined();
    expect(MigrationRunViewSchema.shape.targetServers).toBeDefined();
    expect(MigrationRunViewSchema.shape.sourceVersionVerdict.options).toEqual(["supported", "newer", "too-old", "unknown", "unchecked"]);
  });
});

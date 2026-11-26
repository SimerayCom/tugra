/**
 * P7 one-click migration orchestrator: every zod schema of the REST / MCP / CLI / web surface (commit C0, frozen).
 *
 * One schema = one wire shape. The REST controller validates requests with the request schemas and documents responses
 * with the view schemas (`ApiZodBody` / `ApiZodResponse`); the MCP tools, the CLI request builders (lane D) and the web
 * types (lane E) derive from the same inferred types. Views are SECRET-FREE and carry CODES + PARAMS only (never English
 * text, never source text): the web localizes a code through `migrationRun.codes.<code>`.
 *
 * Instants are ISO-8601 strings on the wire. Persisted JSON columns use exactly the JSON-shape schemas below.
 */
import { z } from "zod";
import { guardedRecord } from "../../common/zod-record";
import { ImportAckSchema, ImportDbDataModesSchema, REMOTE_SOURCE_KINDS, ServiceChoicesSchema } from "../../importer/dto";
import { ImportMappingDocSchema } from "../../importer/import-mapping";
import {
  ATTACH_KINDS,
  CERT_MODES,
  COMMAND_KINDS,
  CONFIRM_KINDS,
  DEPLOY_WAVES,
  SERVICE_START_MODES,
  DEFAULT_DECOMMISSION_MIN_AGE_HOURS,
  DEFAULT_OBSERVE_MINUTES,
  EVENT_LEVELS,
  EVIDENCE_KINDS,
  GATE_CHECK_STATUSES,
  HOST_LOOP_DEFAULTS,
  LARGE_DB_MODES,
  MINIO_POLICIES,
  ORPHAN_VOLUME_POLICIES,
  OWNER_INPUT_KEYS,
  PROGRESS_UNITS,
  ROLLBACK_CLASSES,
  ROW_COUNT_MODES,
  RUN_CODE_RE,
  RUN_MODES,
  RUN_STATUSES,
  RUN_TOPOLOGIES,
  SERVER_MAP_MAX,
  SOURCE_CONTROLLERS,
  SOURCE_RUNNERS,
  SOURCE_VERSION_RE,
  SOURCE_VERSION_VERDICTS,
  STEP_KEYS,
  STEP_KINDS,
  STEP_STATUSES,
  TTL_POLICIES,
  UNLISTED_DB_POLICIES,
  WAIT_KINDS,
  WORKER_POLICIES,
} from "./run-contract";

// ───────────────────────────── primitives ─────────────────────────────

const Id = z.string().min(1).max(64);
/** ISO-8601 instant. */
const Iso = z.string().min(10).max(40);
const Hash32 = z.string().regex(/^[a-f0-9]{32}$/, "invalid hash");
const Hash64 = z.string().regex(/^[a-f0-9]{64}$/, "invalid hash");
/** A stable, lower-case code the web localizes (`migrationRun.codes.<code>`). */
export const RunCodeSchema = z.string().max(80).regex(RUN_CODE_RE, "invalid code");

/** One JSON-safe parameter value of a code (counts, names, ids, hosts: never a secret, never free text from a source). */
const ParamValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null(), z.array(z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).max(200)]);
/** Interpolation parameters of a {@link RunCodeSchema} code. */
export const CodeParamsSchema = guardedRecord(z.string().min(1).max(64), ParamValue).refine((r) => Object.keys(r).length <= 40, "too many params");
export type CodeParams = z.infer<typeof CodeParamsSchema>;

export const RunStatusSchema = z.enum(RUN_STATUSES);
export const StepStatusSchema = z.enum(STEP_STATUSES);
export const StepKeySchema = z.enum(STEP_KEYS);
export const RunModeSchema = z.enum(RUN_MODES);
export const RunTopologySchema = z.enum(RUN_TOPOLOGIES);
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export const OwnerInputKeySchema = z.enum(OWNER_INPUT_KEYS);

/** Generic `{ ok: true }` for actions that return nothing else. */
export const OkSchema = z.object({ ok: z.literal(true) });

// ───────────────────────────── JSON shapes persisted on step rows ─────────────────────────────

/**
 * One gate check. `status: "unknown"` fails wherever data would move. `evidence` says how trustworthy a `pass` is.
 * `ownerInput` names the owner input that would resolve it (the web links to the input form). `ackable` = a human can
 * accept it through an approval (`acks` contains the check `id`); `acked` is set by the engine when they did.
 */
export const GateCheckSchema = z.object({
  id: z.string().min(1).max(80),
  status: z.enum(GATE_CHECK_STATUSES),
  code: RunCodeSchema,
  params: CodeParamsSchema.optional(),
  /** The thing checked (item ref, host, bucket, volume): lets one check id appear once per subject. */
  subject: z.string().max(300).optional(),
  evidence: EvidenceKindSchema.optional(),
  ownerInput: OwnerInputKeySchema.optional(),
  /** The attestation check ids an operator may record for THIS check (one row per check and subject in the panel). */
  attestable: z.array(z.string().max(80)).max(4).optional(),
  ackable: z.boolean().optional(),
  acked: z.boolean().optional(),
});
export type GateCheck = z.infer<typeof GateCheckSchema>;

/** What the human must type and sign for an approval; bound to the exact state they reviewed. */
export const ApprovalBindingSchema = z.object({
  /** sha256 hex of what was reviewed (e.g. `H(verifyReportHash || flipPlanHash || statefulHosts)`). Recomputed every tick. */
  inputHash: Hash64,
  /** True for the point-of-no-return approval: 30 min validity, refused over MCP, sets `acceptDataRisk` requirement. */
  ponr: z.boolean(),
  /** What `confirmName` must equal: the run id, the target server name, the source host, or both for takeover. */
  confirm: z.enum(CONFIRM_KINDS),
  /** Validity in seconds from approval; null = no expiry. */
  ttlSec: z.number().int().positive().nullable(),
  /** The approver must tick the data-risk acknowledgement (stateful hosts at stake). */
  requiresDataRisk: z.boolean(),
  /** Gate check ids a human MAY accept through `acks`. */
  ackable: z.array(z.string().max(80)).max(200),
  /** Gate check ids a human MUST accept (subset of `ackable`). */
  requiredAcks: z.array(z.string().max(80)).max(200),
  /** What the approval form shows (stop list, window estimate, host counts...), as codes + params. */
  review: CodeParamsSchema,
});
export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;

/**
 * Why a step is parked. `operator`: a human acts outside the hub (the optional `attest` ids are checks they may attest
 * through `POST /evidence`; `offersCommand` shows the "get migrator command" action). `approval`: see
 * {@link ApprovalBindingSchema}. `timer`: wait until `notBefore`.
 */
export const WaitSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(WAIT_KINDS[0]),
    code: RunCodeSchema,
    params: CodeParamsSchema.optional(),
    offersCommand: z.boolean().optional(),
    /** Which command the "get command" action mints (default `migrator`); see {@link COMMAND_KINDS}. Only meaningful with `offersCommand`. */
    commandKind: z.enum(COMMAND_KINDS).optional(),
    attest: z.array(z.string().max(80)).max(50).optional(),
  }),
  z.object({ kind: z.literal(WAIT_KINDS[1]), binding: ApprovalBindingSchema }),
  z.object({ kind: z.literal(WAIT_KINDS[2]), notBefore: Iso, code: RunCodeSchema, params: CodeParamsSchema.optional() }),
]);
export type WaitSpec = z.infer<typeof WaitSpecSchema>;

/** The result of a gate. `wait` (set when it fails) says what unblocks it; default is an operator wait. */
export const GateResultSchema = z.object({
  passed: z.boolean(),
  checks: z.array(GateCheckSchema).max(500),
  wait: WaitSpecSchema.optional(),
});
export type GateResult = z.infer<typeof GateResultSchema>;

/** A stored approval. `confirmedName` is what the human typed (names only, never a secret). */
export const StepApprovalRecordSchema = z.object({
  byUserId: Id,
  at: Iso,
  boundHash: Hash64,
  acks: z.array(z.string().max(80)).max(200),
  confirmedName: z.string().max(253).nullable(),
  acceptDataRisk: z.boolean(),
  expiresAt: Iso.nullable(),
});
export type StepApprovalRecord = z.infer<typeof StepApprovalRecordSchema>;

/** One line of a read-only dry-run projection. `block`/`unknown` would stop the real run. */
export const DryRunItemSchema = z.object({
  code: RunCodeSchema,
  level: z.enum(["info", "warn", "block", "unknown"]),
  subject: z.string().max(300).optional(),
  params: CodeParamsSchema.optional(),
});
export type DryRunItem = z.infer<typeof DryRunItemSchema>;

/** Step progress: references to existing tables (transfers, tasks, object migrations), never copies of their data. */
export const StepProgressSchema = z.object({
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  unit: z.enum(PROGRESS_UNITS),
  etaSec: z.number().int().min(0).nullable().optional(),
  /** The dry-run projection of this step (set only on dry-run runs), at most 500 items. */
  dryRun: z.array(DryRunItemSchema).max(500).optional(),
});
export type StepProgress = z.infer<typeof StepProgressSchema>;

/** Operator-supplied evidence of a step: attestations and resources attached to it. */
export const StepEvidenceSchema = z.object({
  attestations: z
    .array(z.object({ checkId: z.string().max(80), subject: z.string().max(300).optional(), note: z.string().max(500).optional(), byUserId: Id, at: Iso }))
    .max(200),
  attachments: z.array(z.object({ kind: z.enum(ATTACH_KINDS), resourceId: Id, byUserId: Id, at: Iso })).max(50),
});
export type StepEvidence = z.infer<typeof StepEvidenceSchema>;

/** The downtime window estimate (basis = the inputs it was derived from). */
export const WindowEstimateSchema = z.object({
  freezeToFlipSec: z.number().int().min(0).nullable(),
  basis: z.array(z.object({ code: RunCodeSchema, params: CodeParamsSchema.optional() })).max(20),
  estimatedAt: Iso,
});
export type WindowEstimate = z.infer<typeof WindowEstimateSchema>;

// ───────────────────────────── multi-host placement, baseline, host loop (grup-7) ─────────────────────────────

/** A source server ref: a Coolify server uuid (printable ASCII; the prototype-pollution names are refused). */
const SourceServerRef = z
  .string()
  .regex(/^[\x21-\x7e]{1,200}$/, "invalid source server ref")
  .refine((k) => k !== "__proto__" && k !== "constructor" && k !== "prototype", "reserved key");

/**
 * Multi-host placement (C1/R12/Q4): source server (Coolify server uuid) to Tugra target server id, so a project that spans
 * 3-6 source hosts migrates in ONE run. At most {@link SERVER_MAP_MAX} entries; many sources may share one target. The run's
 * `targetServerId` stays the default for any source server not listed. Every target must belong to the run's team (checked
 * at create). Names and ids only: no secret.
 */
export const ServerMapSchema = guardedRecord(SourceServerRef, Id)
  .refine((m) => Object.keys(m).length <= SERVER_MAP_MAX, `at most ${SERVER_MAP_MAX} source servers`);
export type ServerMap = z.infer<typeof ServerMapSchema>;

/** A free label that groups the runs of one campaign (R15/R69). Printable text without control characters. */
export const CampaignSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}]+$/u, "invalid campaign label");

/** Health of one source resource at baseline time. `exited` = the container is not running. */
export const BASELINE_HEALTHS = ["healthy", "unhealthy", "unknown", "exited"] as const;

/**
 * The source health baseline (R28/R29/R52/R66): what each source resource looked like BEFORE the run changed anything, so
 * VERIFY and OBSERVE can tell "Tugra broke it" from "it was already crash-looping" (and so 62 apps without a health check
 * have a defined `unknown`). Secret-free: refs, enums and counts.
 */
export const SourceBaselineSchema = z.object({
  capturedAt: Iso,
  entries: z
    .array(
      z.object({
        kind: z.enum(["app", "database", "service"]),
        /** The plan item's source ref. */
        ref: z.string().min(1).max(300),
        /** The source server uuid the resource runs on, when known (per-host baselines). */
        serverRef: z.string().max(200).optional(),
        health: z.enum(BASELINE_HEALTHS),
        /** Container restart count at capture time; null when unknown. */
        restartCount: z.number().int().min(0).nullable(),
      }),
    )
    .max(5000),
});
export type SourceBaseline = z.infer<typeof SourceBaselineSchema>;

/**
 * Options of the `coolify-host-loop` source runner (R32/C2). Directory and numbers only: the hub never stores a key. The
 * list of hosts is NOT an option: it is derived from the run's `serverMap` (see `hostLoopTargets`).
 */
export const HostLoopOptionsSchema = z
  .object({
    /** Directory ON THE COOLIFY HOST holding one private key per managed server (`<keyDir>/ssh_key@<serverUuid>`). Absolute, no shell metacharacters. */
    keyDir: z
      .string()
      .regex(/^\/[A-Za-z0-9._\/-]{0,200}$/, "keyDir must be an absolute path of [A-Za-z0-9._/-]")
      .refine((p) => !p.split("/").includes(".."), "keyDir must not contain ..")
      .default(HOST_LOOP_DEFAULTS.keyDir),
    /** Hosts the loop handles at the same time (the source runs on small hosts; 1 = strictly one after the other). */
    parallel: z.number().int().min(1).max(8).default(HOST_LOOP_DEFAULTS.parallel),
    /** SSH connect timeout per host. */
    connectTimeoutSec: z.number().int().min(5).max(120).default(HOST_LOOP_DEFAULTS.connectTimeoutSec),
    /** Extra attempts per host after a failed connect (flaky links: R44). */
    retries: z.number().int().min(0).max(5).default(HOST_LOOP_DEFAULTS.retries),
  })
  .strict();
export type HostLoopOptions = z.infer<typeof HostLoopOptionsSchema>;

// ───────────────────────────── run options and owner inputs ─────────────────────────────

/**
 * The apps of an in-place run that are built with Tugra and verified instead of reusing the image Coolify built (plan item refs, one
 * `app:<source server>:<ref>` each). Absent or empty = every app reuses its image (the default, nothing is built).
 */
export const RebuildListSchema = z.array(z.string().regex(/^app:[\x21-\x7e]{1,280}$/, "invalid item ref")).max(500);

/**
 * Run options (`MigrationRun.options`). Everything has a safe default, so `RunOptionsSchema.parse({})` is the default
 * run: copy-mode friendly, nothing automatic beyond the hub's own side, operator-run data.
 */
export const RunOptionsSchema = z
  .object({
    /** DNS TTL wait before the flip: `wait` honours the old TTL, `skip-ack` skips it knowingly (recorded). */
    ttlPolicy: z.enum(TTL_POLICIES).default("wait"),
    /** `earlyStateless` deploys stateless apps right after IMPORT (lane A, last slice). */
    deployWaves: z.enum(DEPLOY_WAVES).default("single"),
    /** Take a warm DB dump during DATA_SEED (later replaced by `--resync`). */
    warmDbSeed: z.boolean().default(false),
    /** Pass `--stop-source` to the migrator (it stops the source writers itself). */
    stopSource: z.boolean().default(false),
    /** Who starts the migrator on the source host (`coolify-host-loop`: one script on the Coolify host loops over every mapped source host, R32). */
    sourceRunner: z.enum(SOURCE_RUNNERS).default("operator"),
    /**
     * Source server ref to the Tugra server whose agent runs the source-side scripts of the `agent` runner when the run is not a same-host
     * swap (the source host has its own agent). Hub-derived at create from the plan's host matches: a value the caller sends is discarded.
     * Absent = the agent runner is only available on a swap-proxy run.
     */
    sourceHostServers: z.record(z.string().min(1).max(200), z.string().min(1).max(64)).optional(),
    /** Tuning of the `coolify-host-loop` runner; absent = {@link HOST_LOOP_DEFAULTS} (read it with `hostLoopOf`). */
    hostLoop: HostLoopOptionsSchema.optional(),
    /** Builds started at once per target server (R25: 2 CPU / 4 GB hosts); absent = 1 (read it with `deployConcurrencyOf`). */
    deployConcurrency: z.number().int().min(1).max(8).optional(),
    /** Which imported compose services DEPLOY_DARK starts, before the apps that need them (C14/R30); absent = `dependencies` (read it with `serviceStartOf`). */
    serviceStart: z.enum(SERVICE_START_MODES).optional(),
    /** What happens to a database over the artifact route's cap with no physical lane; absent = `stream-logical`, no size limit (read it with `largeDbModeOf`). */
    largeDbMode: z.enum(LARGE_DB_MODES).optional(),
    /** `seed` copies the source proxy's ACME certs (`--certs`; private keys travel encrypted to the hub, purged after apply). */
    certs: z.enum(CERT_MODES).default("none"),
    /** Accept hosts that only have an HTTP-01 certificate gap at flip time. */
    acceptHttp01Gap: z.boolean().default(false),
    /** Schedule the FREEZE (a timer wait until then). */
    freezeAt: Iso.optional(),
    /** Observe window after CUTOVER; 0 = none. */
    observeMinutes: z.number().int().min(0).max(4320).default(DEFAULT_OBSERVE_MINUTES),
    /** FINALIZE waits for an explicit approval instead of finalizing automatically. */
    manualFinalize: z.boolean().default(false),
    /** DNS flip pacing (two-box only). */
    batchSize: z.number().int().min(1).max(25).default(5),
    intervalSec: z.number().int().min(5).max(600).default(30),
    /** Pin a specific team DNS credential instead of trying them in order. */
    dnsCredentialId: Id.optional(),
    /** Probe path for hub-side host checks (must start with `/`). */
    healthPath: z
      .string()
      .regex(/^\/[\x21-\x7e]{0,254}$/, "healthPath must start with / and be printable ASCII")
      .optional(),
    /** DB logical-parity cost mode. */
    rowCountMode: z.enum(ROW_COUNT_MODES).default("estimate"),
    /** In-place runs only: the apps to build with Tugra and verify (see {@link RebuildListSchema}); a run that is not in place refuses a list. */
    rebuild: RebuildListSchema.optional(),
    /** Minimum run age before DECOMMISSION can be armed (takeover only). */
    decommissionMinAgeHours: z.number().int().min(0).max(24 * 90).default(DEFAULT_DECOMMISSION_MIN_AGE_HOURS),
    /** Notify when a step waits for an operator longer than this (watchdog). */
    stuckOperatorMinutes: z.number().int().min(5).max(24 * 60).default(60),
  })
  .strict();
export type RunOptions = z.infer<typeof RunOptionsSchema>;
export type RunOptionsInput = z.input<typeof RunOptionsSchema>;

/** Where an owner input value came from. */
export const OWNER_INPUT_SOURCES = ["request", "default", "derived"] as const;

const inputRecord = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    /** The value, or the literal `"unknown"` (unanswered owner question: blocks only the step that needs it). */
    value: z.union([value, z.literal("unknown")]),
    source: z.enum(OWNER_INPUT_SOURCES),
    setBy: Id.nullable(),
    at: Iso,
  });

const AcmeEmail = z.string().trim().email().max(254);
const AllowBind = z.boolean();
const AllowLiveShapeProbe = z.boolean();
const SourceControllerValue = z.enum(SOURCE_CONTROLLERS);
const MinioPolicyValue = z.enum(MINIO_POLICIES);
/** Minutes (0 = no gap accepted .. 7 days). */
const TickGapAcceptMinutes = z.number().int().min(0).max(7 * 24 * 60);
const WorkerPolicyValue = z.enum(WORKER_POLICIES);
const UnlistedDbPolicyValue = z.enum(UNLISTED_DB_POLICIES);
const OrphanVolumePolicyValue = z.enum(ORPHAN_VOLUME_POLICIES);

/**
 * The owner questions as run inputs with provenance (`MigrationRun.inputs`). Q3 `acmeEmail` blocks TLS and CUTOVER only;
 * Q5 `allowBind` (default refuse); Q7 `allowLiveShapeProbe` (consent for the read-only live probe, default off); Q8
 * `sourceController` (default `manual`). Q1/Q2/Q4 are derived at runtime and have no input.
 *
 * Added in grup-7 (all fail-closed, see `OWNER_INPUT_DEFAULTS`): Q6 `minioPolicy` (default `hold`), N2 `tickGapAcceptMinutes`
 * (default 0), R26 `workerPolicy` (default `hold-dark`), N3 `unlistedDbPolicy` (default `block`), N4 `orphanVolumePolicy`
 * (default `block`).
 */
export const OwnerInputsSchema = z
  .object({
    acmeEmail: inputRecord(AcmeEmail).optional(),
    allowBind: inputRecord(AllowBind).optional(),
    allowLiveShapeProbe: inputRecord(AllowLiveShapeProbe).optional(),
    sourceController: inputRecord(SourceControllerValue).optional(),
    minioPolicy: inputRecord(MinioPolicyValue).optional(),
    tickGapAcceptMinutes: inputRecord(TickGapAcceptMinutes).optional(),
    workerPolicy: inputRecord(WorkerPolicyValue).optional(),
    unlistedDbPolicy: inputRecord(UnlistedDbPolicyValue).optional(),
    orphanVolumePolicy: inputRecord(OrphanVolumePolicyValue).optional(),
  })
  .strict();
export type OwnerInputs = z.infer<typeof OwnerInputsSchema>;

/** Request form of the owner inputs: bare values (provenance is added server-side), each may be the literal `"unknown"`. */
export const OwnerInputsRequestSchema = z
  .object({
    acmeEmail: z.union([AcmeEmail, z.literal("unknown")]).optional(),
    allowBind: z.union([AllowBind, z.literal("unknown")]).optional(),
    allowLiveShapeProbe: z.union([AllowLiveShapeProbe, z.literal("unknown")]).optional(),
    sourceController: z.union([SourceControllerValue, z.literal("unknown")]).optional(),
    minioPolicy: z.union([MinioPolicyValue, z.literal("unknown")]).optional(),
    tickGapAcceptMinutes: z.union([TickGapAcceptMinutes, z.literal("unknown")]).optional(),
    workerPolicy: z.union([WorkerPolicyValue, z.literal("unknown")]).optional(),
    unlistedDbPolicy: z.union([UnlistedDbPolicyValue, z.literal("unknown")]).optional(),
    orphanVolumePolicy: z.union([OrphanVolumePolicyValue, z.literal("unknown")]).optional(),
  })
  .strict();
export type OwnerInputsRequest = z.infer<typeof OwnerInputsRequestSchema>;

// ───────────────────────────── create ─────────────────────────────

const REMOTE_KINDS = z.enum(REMOTE_SOURCE_KINDS);

/** The editable-mapping and apply fields shared by the frozen apply input and the create body (same names as importer apply). */
export const applyFields = {
  sourceKind: REMOTE_KINDS,
  targetServerId: Id,
  environmentId: Id.optional(),
  /** The importer plan hash the caller reviewed (32 hex); mode/topology are NOT part of it. */
  planHash: Hash32,
  acks: z.array(ImportAckSchema).max(2000).optional(),
  serviceChoices: ServiceChoicesSchema.optional(),
  mapping: ImportMappingDocSchema.optional(),
  mappingHash: Hash32.optional(),
  reconcile: z.boolean().optional(),
  ignoreStoredMapping: z.boolean().optional(),
  saveMapping: z.boolean().optional(),
  dbDataModes: ImportDbDataModesSchema.optional(),
};

const mappingPair = (v: { mapping?: unknown; mappingHash?: unknown }, ctx: z.RefinementCtx) => {
  if ((v.mapping !== undefined) !== (v.mappingHash !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [v.mapping === undefined ? "mapping" : "mappingHash"], message: "mapping and mappingHash must be sent together" });
  }
};

/**
 * The frozen, SECRET-FREE apply input stored in `MigrationRun.applyInput`: names, placement and ack codes only. The
 * source token stays in the encrypted `ImportSession`; the session id lives on the run, not here. IMPORT builds the
 * importer's `ImportApplyInput` from this plus `run.sessionId`.
 */
export const RunApplyInputSchema = z.object(applyFields).strict().superRefine(mappingPair);
export type RunApplyInput = z.infer<typeof RunApplyInputSchema>;

const ScopeRef = z.string().regex(/^[\x21-\x7e]{1,200}$/, "invalid ref");
const ScopeItemRef = z.string().regex(/^(app|database|service):[\x21-\x7e]{1,280}$/, "invalid item ref");

/**
 * What a guided run moves when it is not the whole source: source servers and source projects to move (their items are in), items to
 * pull in on top, items to leave out (always wins). Refs are the ones the plan shows. At least one of `sourceServers`, `projects`
 * and `include` is needed; absent `scope` = everything. The hub turns it into the importer's own exclusions (see `run-scope.ts`).
 */
export const RunScopeSchema = z
  .object({
    sourceServers: z.array(ScopeRef).max(SERVER_MAP_MAX * 4).optional(),
    projects: z.array(ScopeRef).max(500).optional(),
    include: z.array(ScopeItemRef).max(2000).optional(),
    exclude: z.array(ScopeItemRef).max(2000).optional(),
  })
  .strict()
  .refine((s) => (s.sourceServers?.length ?? 0) + (s.projects?.length ?? 0) + (s.include?.length ?? 0) > 0, "a scope names at least one source server, project or item");
export type RunScope = z.infer<typeof RunScopeSchema>;

/**
 * `POST /migration-runs`. `sessionId` + `planHash` bind the run to the plan the caller reviewed (409 when the source
 * changed). `dryRun: true` creates a run that only projects (never writes outside its own rows) and ends `DRY_RUN_DONE`.
 * `topology: "side-by-side"` is not accepted (400): not available in v1. `serverMap` and `campaign` are run-level (stored in
 * their own columns, NOT part of the frozen apply input or the plan hash).
 */
export const CreateMigrationRunSchema = z
  .object({
    sessionId: Id,
    ...applyFields,
    mode: RunModeSchema.default("copy"),
    topology: RunTopologySchema.default("two-box"),
    dryRun: z.boolean().default(false),
    options: RunOptionsSchema.prefault({}),
    inputs: OwnerInputsRequestSchema.default({}),
    /** Multi-host placement (see {@link ServerMapSchema}); `targetServerId` stays the default for unmapped sources. Absent = single target. */
    serverMap: ServerMapSchema.optional(),
    /** Groups the runs of one campaign (see {@link CampaignSchema}). */
    campaign: CampaignSchema.optional(),
    /** Narrow the run to some source servers / projects / items (see {@link RunScopeSchema}). Absent = the whole source. Not combined with `mapping`. */
    scope: RunScopeSchema.optional(),
  })
  .strict()
  .superRefine(mappingPair)
  .superRefine((v, ctx) => {
    if (v.scope && (v.mapping !== undefined || v.mappingHash !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: "scope cannot be combined with mapping: the hub builds the mapping from the scope" });
    }
  });
export type CreateMigrationRunInput = z.infer<typeof CreateMigrationRunSchema>;

// ───────────────────────────── step / run action bodies ─────────────────────────────

/** `POST /:id/start`. `sessionId` is only used when promoting a `DRY_RUN_DONE` run whose session expired. */
export const StartRunSchema = z.object({ sessionId: Id.optional() }).strict();
export type StartRunInput = z.infer<typeof StartRunSchema>;

/**
 * `POST /:id/steps/:key/approve`. `boundHash` MUST equal the binding the step currently shows (409 `approval-stale`
 * otherwise). `confirmName` is typed by the human and compared server-side to the binding's `confirm` kind.
 */
export const StepApproveSchema = z
  .object({
    boundHash: Hash64,
    acks: z.array(z.string().min(1).max(80)).max(200).default([]),
    confirmName: z.string().trim().min(1).max(253).optional(),
    acceptDataRisk: z.boolean().optional(),
  })
  .strict();
export type StepApproveInput = z.infer<typeof StepApproveSchema>;

/** `POST /:id/steps/:key/retry`. */
export const StepRetrySchema = z.object({}).strict();
export type StepRetryInput = z.infer<typeof StepRetrySchema>;

/** `POST /:id/steps/:key/skip` (only `skippable` steps: DATA_SEED). */
export const StepSkipSchema = z.object({ reason: z.string().trim().max(300).optional() }).strict();
export type StepSkipInput = z.infer<typeof StepSkipSchema>;

/** `POST /:id/steps/:key/evidence`: an operator attestation for a check the step's wait listed in `attest`. */
export const StepEvidenceInputSchema = z
  .object({ checkId: z.string().min(1).max(80), subject: z.string().max(300).optional(), note: z.string().trim().max(500).optional() })
  .strict();
export type StepEvidenceInput = z.infer<typeof StepEvidenceInputSchema>;

/** `POST /:id/steps/:key/attach`: attach an existing resource (object credentials never pass through the run API). */
export const AttachSchema = z.object({ kind: z.enum(ATTACH_KINDS), resourceId: Id }).strict();
export type AttachInput = z.infer<typeof AttachSchema>;

/**
 * `POST /:id/steps/:key/command`: mint or reissue the command of the step. `kind` (default `migrator`, the classic one-host
 * bootstrap) picks which command: see {@link COMMAND_KINDS}.
 */
export const RunCommandSchema = z.object({ reissue: z.boolean().default(false), kind: z.enum(COMMAND_KINDS).optional() }).strict();
export type RunCommandInput = z.infer<typeof RunCommandSchema>;

/** `POST /:id/inputs`: at least one owner input. */
export const SetRunInputsSchema = OwnerInputsRequestSchema.refine((v) => Object.keys(v).length > 0, "at least one input is required");
export type SetRunInputsInput = z.infer<typeof SetRunInputsSchema>;

/** `POST /:id/abort`: `confirmName` = the run id. Before PONR only. */
export const AbortRunSchema = z.object({ confirmName: z.string().trim().min(1).max(253) }).strict();
export type AbortRunInput = z.infer<typeof AbortRunSchema>;

/** `POST /:id/cleanup`: `confirmName` = the run id; data-bearing resources need `includeData` plus their typed names. */
export const CleanupRunSchema = z
  .object({
    confirmName: z.string().trim().min(1).max(253),
    includeData: z.boolean().default(false),
    dataConfirmNames: z.array(z.string().trim().min(1).max(253)).max(500).default([]),
  })
  .strict();
export type CleanupRunInput = z.infer<typeof CleanupRunSchema>;

/** `POST /:id/reverse`: `confirmName` = the run id, plus the literal data-loss acknowledgement. */
export const ReverseRunSchema = z.object({ confirmName: z.string().trim().min(1).max(253), acknowledgeDataLoss: z.literal(true) }).strict();
export type ReverseRunInput = z.infer<typeof ReverseRunSchema>;

/** `POST /:id/decommission`: `confirmName` = the source instance host. */
export const DecommissionRunSchema = z.object({ confirmName: z.string().trim().min(1).max(253) }).strict();
export type DecommissionRunInput = z.infer<typeof DecommissionRunSchema>;

/** `POST /:id/source-session`: re-enter the source token (never returned, stored encrypted in the ImportSession). */
export const SourceSessionSchema = z.object({ token: z.string().min(1).max(4096) }).strict();
export type SourceSessionInput = z.infer<typeof SourceSessionSchema>;
export const SourceSessionResultSchema = z.object({ sessionId: Id, expiresAt: Iso });
export type SourceSessionResult = z.infer<typeof SourceSessionResultSchema>;

// ───────────────────────────── queries ─────────────────────────────

/** `GET /migration-runs`. */
export const ListMigrationRunsQuerySchema = z.object({
  teamId: Id.optional(),
  status: RunStatusSchema.optional(),
  /** `true` = only live runs (`LIVE_RUN_STATUSES`). */
  active: z.enum(["true", "false"]).optional(),
  /** Only the runs of this campaign label. */
  campaign: CampaignSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListMigrationRunsQuery = z.infer<typeof ListMigrationRunsQuerySchema>;

/** `GET /:id/events`: `afterSeq` is the last seq the client has (0 = from the start). */
export const RunEventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type RunEventsQuery = z.infer<typeof RunEventsQuerySchema>;

/** `GET /:id/report`. */
export const RunReportQuerySchema = z.object({ format: z.enum(["json", "md"]).default("json") });
export type RunReportQuery = z.infer<typeof RunReportQuerySchema>;

// ───────────────────────────── views (responses) ─────────────────────────────

/** One event of the append-only log. Codes + params only. */
export const RunEventViewSchema = z.object({
  seq: z.number().int(),
  at: Iso,
  stepKey: StepKeySchema.nullable(),
  level: z.enum(EVENT_LEVELS),
  code: RunCodeSchema,
  params: CodeParamsSchema.nullable(),
  actorId: Id.nullable(),
});
export type RunEventView = z.infer<typeof RunEventViewSchema>;

export const RunEventsPageSchema = z.object({
  events: z.array(RunEventViewSchema),
  /** The highest seq in `events` (or the request's `afterSeq` when empty): pass it back as the next `afterSeq`. */
  lastSeq: z.number().int().min(0),
  hasMore: z.boolean(),
});
export type RunEventsPage = z.infer<typeof RunEventsPageSchema>;

/** What the UI may offer on a step right now, precomputed so clients never re-derive the state machine. */
export const StepAllowedSchema = z.object({
  approve: z.boolean(),
  retry: z.boolean(),
  skip: z.boolean(),
  evidence: z.boolean(),
  attach: z.boolean(),
  command: z.boolean(),
});
export type StepAllowed = z.infer<typeof StepAllowedSchema>;

export const MigrationRunStepViewSchema = z.object({
  key: StepKeySchema,
  idx: z.number().int(),
  kind: z.enum(STEP_KINDS),
  status: StepStatusSchema,
  rollbackClass: z.enum(ROLLBACK_CLASSES),
  attempt: z.number().int(),
  /** Why a step with status SKIPPED was skipped (a code), else null. */
  skippedCode: RunCodeSchema.nullable(),
  gate: GateResultSchema.nullable(),
  /** The stored approval WITHOUT the typed name (names are in the audit log). */
  approval: StepApprovalRecordSchema.omit({ confirmedName: true }).nullable(),
  /** What the step is parked on (null when not waiting). */
  wait: WaitSpecSchema.nullable(),
  progress: StepProgressSchema.nullable(),
  evidence: StepEvidenceSchema,
  notBefore: Iso.nullable(),
  startedAt: Iso.nullable(),
  finishedAt: Iso.nullable(),
  /** Fixed failure code, never raw text. */
  lastError: RunCodeSchema.nullable(),
  allowed: StepAllowedSchema,
});
export type MigrationRunStepView = z.infer<typeof MigrationRunStepViewSchema>;

/**
 * "What I am waiting for": exactly one per run, naming who can unblock it and since when.
 *  `operator` / `approval` / `timer`: from the current step's {@link WaitSpecSchema}; `gate`: a pre-gate blocks;
 *  `session`: the source token must be re-entered; `paused` / `failed`: the run needs a decision; `engine`: the hub is
 *  working (nothing for a human to do); `none`: terminal.
 */
export const NextActionSchema = z.object({
  kind: z.enum(["operator", "approval", "timer", "gate", "session", "paused", "failed", "engine", "none"]),
  stepKey: StepKeySchema.nullable(),
  code: RunCodeSchema,
  params: CodeParamsSchema.optional(),
  since: Iso,
  notBefore: Iso.nullable().optional(),
  /** Set when `kind === "approval"`. */
  approval: ApprovalBindingSchema.optional(),
  attest: z.array(z.string().max(80)).optional(),
  offersCommand: z.boolean().optional(),
});
export type NextAction = z.infer<typeof NextActionSchema>;

/** What the UI may offer on the run right now. */
export const RunAllowedSchema = z.object({
  start: z.boolean(),
  pause: z.boolean(),
  resume: z.boolean(),
  abort: z.boolean(),
  cleanup: z.boolean(),
  reverse: z.boolean(),
  decommission: z.boolean(),
  setInputs: z.boolean(),
  sourceSession: z.boolean(),
});
export type RunAllowed = z.infer<typeof RunAllowedSchema>;

const OwnerInputsViewSchema = OwnerInputsSchema;

/** One target server of a (multi-host) run. `primary` = the run's default `targetServerId`. */
export const RunTargetServerSchema = z.object({ serverId: Id, serverName: z.string().nullable(), primary: z.boolean() });
export type RunTargetServer = z.infer<typeof RunTargetServerSchema>;

/** The full, secret-free run view (`GET /migration-runs/:id` and the response of every action). */
export const MigrationRunViewSchema = z.object({
  id: Id,
  teamId: Id,
  /** The creator, the only user who drives the run. */
  actorId: Id,
  /** The default target server (every source server the `serverMap` does not map lands here). */
  targetServerId: Id,
  targetServerName: z.string().nullable(),
  /** The multi-host placement: source server (Coolify server uuid) to target server id; `{}` for a single-target run. */
  serverMap: z.record(z.string(), Id),
  /** Every target server of the run (default first, each once) with its display name; what a typed confirmation must name. */
  targetServers: z.array(RunTargetServerSchema),
  sourceKind: z.enum(REMOTE_SOURCE_KINDS),
  sourceHost: z.string().nullable(),
  /** The source's version string, null until known. */
  sourceVersion: z.string().max(64).nullable(),
  /** How {@link sourceVersion} compares to the supported range (derived on read). */
  sourceVersionVerdict: z.enum(SOURCE_VERSION_VERDICTS),
  /** The campaign label, null when none. */
  campaign: z.string().nullable(),
  /** When the source health baseline was captured (the baseline itself is not in the view), null until captured. */
  baselineAt: Iso.nullable(),
  opId: Id.nullable(),
  opHistory: z.array(Id),
  planHash: Hash32,
  mode: RunModeSchema,
  topology: RunTopologySchema,
  dryRun: z.boolean(),
  /** An in-place takeover (same machine, Coolify's images reused or rebuilt with Tugra, no data copy): set by a campaign, never by a request body. */
  inPlace: z.boolean(),
  promotedFromId: Id.nullable(),
  status: RunStatusSchema,
  currentStep: StepKeySchema.nullable(),
  /** Set once the point of no return was reached; abort is refused from then on. */
  ponrAt: Iso.nullable(),
  pauseRequested: z.boolean(),
  abortRequested: z.boolean(),
  options: RunOptionsSchema,
  inputs: OwnerInputsViewSchema,
  windowEstimate: WindowEstimateSchema.nullable(),
  freezeStartedAt: Iso.nullable(),
  freezeEndedAt: Iso.nullable(),
  /** `freezeEndedAt - freezeStartedAt` in seconds once both are set, else null. */
  measuredDowntimeSec: z.number().int().min(0).nullable(),
  failure: z.object({ step: StepKeySchema.nullable(), code: RunCodeSchema }).nullable(),
  nextAction: NextActionSchema,
  allowed: RunAllowedSchema,
  steps: z.array(MigrationRunStepViewSchema),
  /** The seq of the latest event (the web polls `/events?afterSeq=` from here). */
  eventSeq: z.number().int().min(0),
  createdAt: Iso,
  startedAt: Iso.nullable(),
  finishedAt: Iso.nullable(),
  updatedAt: Iso,
});
export type MigrationRunView = z.infer<typeof MigrationRunViewSchema>;

/** Row of `GET /migration-runs` (no steps). */
export const MigrationRunSummarySchema = z.object({
  id: Id,
  teamId: Id,
  targetServerId: Id,
  targetServerName: z.string().nullable(),
  /** How many distinct target servers the run places resources on (1 for a single-target run). */
  targetServerCount: z.number().int().min(1),
  sourceKind: z.enum(REMOTE_SOURCE_KINDS),
  sourceHost: z.string().nullable(),
  sourceVersion: z.string().max(64).nullable(),
  campaign: z.string().nullable(),
  mode: RunModeSchema,
  topology: RunTopologySchema,
  dryRun: z.boolean(),
  inPlace: z.boolean(),
  status: RunStatusSchema,
  currentStep: StepKeySchema.nullable(),
  ponrAt: Iso.nullable(),
  stepsPassed: z.number().int().min(0),
  stepsTotal: z.number().int().min(0),
  nextActionKind: NextActionSchema.shape.kind,
  failure: z.object({ step: StepKeySchema.nullable(), code: RunCodeSchema }).nullable(),
  createdAt: Iso,
  startedAt: Iso.nullable(),
  finishedAt: Iso.nullable(),
});
export type MigrationRunSummary = z.infer<typeof MigrationRunSummarySchema>;

/** `POST /steps/:key/command` response. The live token inside `command`/`commands` is shown ONCE. */
export const RunCommandResultSchema = z.object({
  stepKey: StepKeySchema,
  opId: Id,
  expiresAt: Iso,
  /** Which command this is (echoes the request's `kind`). */
  kind: z.enum(COMMAND_KINDS).default("migrator"),
  /** The source-host bootstrap (carries the live token); the `host-loop` kind is a multi-line script. */
  command: z.string(),
  /** The three streamed-copy commands (inspect, run, resume), when the streamed copy is enabled. */
  commands: z.object({ dryRun: z.string(), run: z.string(), resume: z.string() }).optional(),
  shownOnce: z.literal(true),
});
export type RunCommandResult = z.infer<typeof RunCommandResultSchema>;

// ───────────────────────────── report ─────────────────────────────

/** Outcome of one migrated thing in the final report. */
export const REPORT_ITEM_OUTCOMES = ["moved", "skipped", "acked", "failed", "not-cut-over"] as const;
export const REPORT_ITEM_KINDS = ["app", "database", "service", "volume", "bucket", "domain"] as const;

/**
 * The final, secret-free report (`GET /:id/report`): what moved, what did not (reason codes), the evidence kinds and
 * the measured downtime window against the estimate. Built on demand for an unfinished run.
 */
export const RunReportSchema = z.object({
  runId: Id,
  generatedAt: Iso,
  status: RunStatusSchema,
  mode: RunModeSchema,
  topology: RunTopologySchema,
  dryRun: z.boolean(),
  source: z.object({ kind: z.enum(REMOTE_SOURCE_KINDS), host: z.string().nullable(), version: z.string().max(64).nullable().default(null) }),
  /** The default target server. */
  target: z.object({ serverId: Id, serverName: z.string().nullable() }),
  /** Every target server of the run (default first); `[]` in reports stored before multi-host runs. */
  targets: z.array(z.object({ serverId: Id, serverName: z.string().nullable() })).max(SERVER_MAP_MAX + 1).default([]),
  /** The campaign label, when the run has one. */
  campaign: z.string().nullable().default(null),
  ponrAt: Iso.nullable(),
  window: z.object({ estimatedSec: z.number().int().min(0).nullable(), measuredSec: z.number().int().min(0).nullable() }),
  steps: z.array(
    z.object({ key: StepKeySchema, status: StepStatusSchema, attempts: z.number().int(), durationSec: z.number().int().min(0).nullable(), code: RunCodeSchema.nullable() }),
  ),
  items: z
    .array(
      z.object({
        kind: z.enum(REPORT_ITEM_KINDS),
        name: z.string().max(300),
        outcome: z.enum(REPORT_ITEM_OUTCOMES),
        code: RunCodeSchema.nullable(),
        evidence: EvidenceKindSchema.nullable(),
      }),
    )
    .max(5000),
  /**
   * Per database: how its data travelled, its size, ONE checksum of the whole artifact and the row-count check against the source
   * (`[]` in reports stored before this section existed). The checksum is a hex sha256; the row check compares every table.
   */
  dataIntegrity: z
    .array(
      z.object({
        itemRef: z.string().max(300),
        name: z.string().max(300),
        engine: z.string().max(40),
        /** `dump`: one gzip dump; `stream`: a checked stream of parts; `files`: a copy of the data directory. */
        lane: z.enum(["dump", "stream", "files"]),
        bytes: z.number().int().min(0).nullable(),
        parts: z.number().int().min(0).nullable(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
        rows: z.object({
          /** `match`: every table equal; `close`: equal within an estimate's tolerance (or more rows on the target); `mismatch`: rows are missing; `unverified`: not measured on both sides. */
          status: z.enum(["match", "close", "mismatch", "unverified"]),
          mode: z.enum(["exact", "estimate"]).nullable(),
          relations: z.number().int().min(0).nullable(),
          differing: z.number().int().min(0).nullable(),
          sourceRows: z.number().int().min(0).nullable(),
          targetRows: z.number().int().min(0).nullable(),
          names: z.array(z.string().max(200)).max(10),
        }),
      }),
    )
    .max(2000)
    .default([]),
  /** How many results of each evidence kind the run relied on. */
  evidenceSummary: z.object({
    "hub-verified": z.number().int(),
    "migrator-reported": z.number().int(),
    "operator-attested": z.number().int(),
    "source-api-reported": z.number().int().default(0),
    "host-loop-reported": z.number().int().default(0),
  }),
  /** Operator actions still required (printed source steps, removal commands...), as codes + params. */
  manual: z.array(z.object({ code: RunCodeSchema, params: CodeParamsSchema.optional() })).max(200),
});
export type RunReport = z.infer<typeof RunReportSchema>;

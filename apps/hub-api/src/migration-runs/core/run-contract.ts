/**
 * P7 one-click migration orchestrator: THE CONTRACT (commit C0).
 *
 * Lanes B (data/freeze/verify), C (cutover/TLS/swap/observe/decommission), D (CLI/MCP/docs) and E (web) build against
 * this file and `./dto.ts` IN PARALLEL and cannot change them. Lane A (run core) implements the engine behind them.
 * Anything not expressible here is a new ADDITIVE type in the lane's own files, never an edit of these two.
 *
 * Layering. A `MigrationRun` sits ABOVE the importer's `BulkOperation`; it never replaces it. Every step is a
 * {@link StepHandler} that calls the existing services (importer executor, cutover, vx, proxy-ops, ...) as the run's
 * actor; those services already re-check team permissions and op ownership.
 *
 * Wire conventions (apply to every type below):
 *  - Persisted/JSON values hold ISO-8601 strings for instants; only {@link RunSnapshot}/{@link StepSnapshot} columns
 *    that map 1:1 onto a DB timestamp are `Date`.
 *  - The engine, events, gates and views carry CODES + PARAMS only: no English text, no source text, no secret. The
 *    web maps `code` to `migrationRun.codes.<code>` in the locale JSON (same pattern as importer `reason.ts`).
 *  - A code is lower-case dotted/dashed ({@link RUN_CODE_RE}); handler codes are prefixed by the step key in
 *    kebab-case (`preflight.agent-offline`, `data-final.transfer-diverged`, `cutover.host-not-verified`).
 *  - `unknown` is a failure wherever data would move (vx-gates rule): see {@link makeGate}.
 */
import type {
  AbortRunInput,
  ApprovalBinding,
  AttachInput,
  CleanupRunInput,
  CodeParams,
  CreateMigrationRunInput,
  DecommissionRunInput,
  DryRunItem,
  GateCheck,
  GateResult,
  ListMigrationRunsQuery,
  MigrationRunSummary,
  MigrationRunView,
  OwnerInputs,
  ReverseRunInput,
  RunApplyInput,
  RunCommandInput,
  RunCommandResult,
  RunEventsPage,
  RunEventsQuery,
  SourceAgentsQuery,
  SourceAgentsResult,
  RunOptions,
  RunReport,
  ServerMap,
  SourceBaseline,
  SetRunInputsInput,
  SourceSessionInput,
  SourceSessionResult,
  StartRunInput,
  StepApprovalRecord,
  StepApproveInput,
  StepEvidence,
  StepEvidenceInput,
  StepProgress,
  StepRetryInput,
  StepSkipInput,
  WaitSpec,
  WindowEstimate,
} from "./dto";

// ───────────────────────────── vocabulary (single source of truth; dto.ts builds its zod enums from these) ──────────

/**
 * The 14 step keys in execution order. The first 13 are the linear flow; `DECOMMISSION` is the separate, armed,
 * takeover-only action: its step row exists ONLY for `mode: "takeover"` runs, stays `PENDING` after FINALIZE, and is
 * driven only by `POST /migration-runs/:id/decommission` (see {@link StepManifestEntry.manual}). The engine never
 * advances into it by itself.
 */
export const STEP_KEYS = [
  "PREFLIGHT",
  "IMPORT",
  "DNS_PREPARE",
  "DATA_SEED",
  "FREEZE",
  "DATA_FINAL",
  "REMAP_ENV",
  "DEPLOY_DARK",
  "TLS_PREISSUE",
  "VERIFY",
  "CUTOVER",
  "OBSERVE",
  "FINALIZE",
  "DECOMMISSION",
] as const;
export type StepKey = (typeof STEP_KEYS)[number];
export const isStepKey = (v: unknown): v is StepKey => typeof v === "string" && (STEP_KEYS as readonly string[]).includes(v);

/**
 * A step's PRIMARY mode (stored in `MigrationRunStep.kind`). It is a hint for the UI and the manifest; at runtime any
 * step may emit any {@link WaitSpec} (REMAP_ENV is `auto` but may wait for an approval; FREEZE is `approval` but then
 * waits for an operator).
 *  - `auto`: the hub drives it end to end.
 *  - `operator`: a human runs something outside the hub (the migrator on the source host); the engine only observes.
 *  - `approval`: a typed, hash-bound human approval gates the act.
 *  - `timer`: a wall-clock wait (`notBefore`) dominates (DNS TTL, observe window).
 */
export const STEP_KINDS = ["auto", "operator", "approval", "timer"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * What undoing a step costs (stored in `MigrationRunStep.rollbackClass`):
 *  - `FREE`: nothing to undo.
 *  - `UNDOABLE`: undone completely by `compensate("abort")` (and, for IMPORT, `compensate("cleanup")`).
 *  - `LOSSY_AFTER_PONR`: after the point of no return only `compensate("reverse")` exists and it can lose data Tugra
 *    wrote after the flip (never automatic for stateful hosts).
 *  - `IRREVERSIBLE`: cannot be undone (benign: TTL restore, report write, source retirement).
 */
export const ROLLBACK_CLASSES = ["FREE", "UNDOABLE", "LOSSY_AFTER_PONR", "IRREVERSIBLE"] as const;
export type RollbackClass = (typeof ROLLBACK_CLASSES)[number];

/** Mirrors the Prisma enum `MigrationRunStatus` (a spec asserts they are equal). */
export const RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "WAITING",
  "PAUSED",
  "ABORTING",
  "ABORTED",
  "ROLLING_BACK",
  "ROLLED_BACK",
  "REVERSING",
  "REVERSED",
  "COMPLETED",
  "FAILED",
  "DRY_RUN_DONE",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Mirrors the Prisma enum `MigrationRunStepStatus` (a spec asserts they are equal). */
export const STEP_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING_OPERATOR",
  "WAITING_APPROVAL",
  "WAITING_TIMER",
  "PASSED",
  "FAILED",
  "SKIPPED",
  "COMPENSATED",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/**
 * Statuses in which a REAL (non-dry) run holds `activeKey = srv:<targetServerId>` (one live run per target server).
 * `ABORTED` is NOT live: Coolify is authoritative again and the server is free; the stopped Tugra copies are cleaned
 * up by the optional `cleanup` action. `FAILED` is live on purpose (the operator can still retry or abort).
 */
export const LIVE_RUN_STATUSES: readonly RunStatus[] = ["QUEUED", "RUNNING", "WAITING", "PAUSED", "ABORTING", "ROLLING_BACK", "REVERSING", "FAILED"];
/** Settled for good: no engine work remains. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["ABORTED", "ROLLED_BACK", "REVERSED", "COMPLETED", "DRY_RUN_DONE"];
export const isLiveRunStatus = (s: RunStatus): boolean => LIVE_RUN_STATUSES.includes(s);
export const isTerminalRunStatus = (s: RunStatus): boolean => TERMINAL_RUN_STATUSES.includes(s);

/** `ImportMode` of the importer: `takeover` only decides whether DECOMMISSION can be armed. Never part of `planHash`. */
export const RUN_MODES = ["copy", "takeover"] as const;
export type RunMode = (typeof RUN_MODES)[number];
/**
 * `CoexistenceStrategy` minus `side-by-side` (that enum value is kept in the importer types but a run rejects it with
 * 400: not available in v1). `topology` decides the cutover mechanism: DNS flip (`two-box`) or same-host proxy swap
 * (`swap-proxy`). Never part of `planHash`.
 */
export const RUN_TOPOLOGIES = ["two-box", "swap-proxy"] as const;
export type RunTopology = (typeof RUN_TOPOLOGIES)[number];

/**
 * Who starts the migrator on the source host (design 5.2). `agent` needs the opt-in `migrate` capability (lane B).
 * `coolify-host-loop` (fleet requirement R32/C2): the only reach to the sources is SSH FROM the Coolify host, which holds one
 * key per managed server. The hub prints ONE script for the operator to run on that host; it loops over every source host
 * of the run (the list is derived from {@link ServerMap} keys, see {@link hostLoopTargets}) and starts the migrator on each
 * through the host's own keys. No key, key path content or secret is ever stored or printed by the hub (only the key
 * DIRECTORY, {@link HostLoopOptions.keyDir}, an option the operator may change).
 */
export const SOURCE_RUNNERS = ["operator", "agent", "coolify-host-loop"] as const;
export type SourceRunner = (typeof SOURCE_RUNNERS)[number];
/** Who freezes/restarts the source writers (design 5.2). `manual` is the default (owner question 8 unanswered). */
export const SOURCE_CONTROLLERS = ["manual", "api", "agent"] as const;
export type SourceController = (typeof SOURCE_CONTROLLERS)[number];

/** DNS TTL wait policy: `wait` (default) honours `earliestFlipAt`; `skip-ack` lets the operator skip it knowingly. */
export const TTL_POLICIES = ["wait", "skip-ack"] as const;
export type TtlPolicy = (typeof TTL_POLICIES)[number];
/**
 * `single` deploys everything at DEPLOY_DARK; `earlyStateless` deploys stateless apps right after IMPORT (A, last slice);
 * `earlyBuild` (R27/C5) BUILDS every app image right after IMPORT (a stopped, build-only deploy), long before FREEZE, so the
 * 74 Dockerfile builds of the real fleet are not inside the downtime window; DEPLOY_DARK then only starts the built images.
 * Whether the importer/executor can build without starting is the topology lane's job; the option is the switch.
 */
export const DEPLOY_WAVES = ["single", "earlyStateless", "earlyBuild"] as const;
export type DeployWaves = (typeof DEPLOY_WAVES)[number];
/** ACME certificate source before the flip: `none` = issue on the target, `seed` = copy the source's certs (`--certs`). */
export const CERT_MODES = ["none", "seed"] as const;
export type CertMode = (typeof CERT_MODES)[number];
/** DB logical-parity cost mode (design 4.1): exact counts or estimates (shown to the operator as such). */
export const ROW_COUNT_MODES = ["exact", "estimate"] as const;
export type RowCountMode = (typeof ROW_COUNT_MODES)[number];

/**
 * How trustworthy a gate result/evidence row is (design 4.1). The UI shows it as a badge; never upgrade silently.
 *  - `hub-verified`: the hub checked it itself (its own probe, its own DB).
 *  - `migrator-reported`: the migrator binary on the source host reported it.
 *  - `operator-attested`: a human attested it.
 *  - `source-api-reported` (grup-7): read from the source's API (Coolify version, health, restart counts, the inventory
 *    list). The hub made the call, but the claim is the source's and a read-only token may not see everything.
 *  - `host-loop-reported` (grup-7): measured by a read-only probe of the `coolify-host-loop` script (`docker ps`, `du` of a
 *    bind mount, ...) and carried back by the operator; the hub cannot check it independently.
 */
export const EVIDENCE_KINDS = ["hub-verified", "migrator-reported", "operator-attested", "source-api-reported", "host-loop-reported"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** `unknown` is NOT a pass: it fails wherever data would move (see {@link makeGate}). */
export const GATE_CHECK_STATUSES = ["pass", "fail", "warn", "unknown"] as const;
export type GateCheckStatus = (typeof GATE_CHECK_STATUSES)[number];

export const EVENT_LEVELS = ["info", "warn", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

/**
 * The owner questions as typed run inputs (design 7 plus the fleet analysis). Q1/Q2/Q4 are derived at runtime (Q4 is now the
 * {@link ServerMap}), so they have no input. Every input added in grup-7 has a documented FAIL-CLOSED default in
 * {@link OWNER_INPUT_DEFAULTS}: an unanswered question can only make the run stop or hold something back, never act.
 */
export const OWNER_INPUT_KEYS = [
  "acmeEmail",
  "allowBind",
  "allowLiveShapeProbe",
  "sourceController",
  "minioPolicy",
  "tickGapAcceptMinutes",
  "workerPolicy",
  "unlistedDbPolicy",
  "orphanVolumePolicy",
] as const;
export type OwnerInputKey = (typeof OWNER_INPUT_KEYS)[number];

/**
 * Q6 / C7 (R34): what happens to apps that depend on a source MinIO (object storage). Unknown must not silently block every
 * backend at CUTOVER, so the answer is asked up front and the default holds only the dependents back:
 *  - `hold` (default): buckets are not mirrored and every host whose app depends on a MinIO stays on the source (not cut over).
 *  - `mirror`: `mc mirror` each bucket, verify, and cut dependents over only after their buckets verified (R61 imageproxy).
 *  - `external`: the MinIO stays where it is and the apps keep using its public endpoint (no data movement, no remap).
 */
export const MINIO_POLICIES = ["hold", "mirror", "external"] as const;
export type MinioPolicy = (typeof MINIO_POLICIES)[number];
/**
 * R26 / C13: what happens to workers (apps with no domain: queue consumers, price feeds, mailers). A dark worker can send
 * mail or replay jobs while the source is still authoritative.
 *  - `hold-dark` (default): the worker is imported and built but kept STOPPED until after CUTOVER.
 *  - `start-dark`: the owner accepts that the worker runs on Tugra before CUTOVER (duplicate side effects possible).
 *  - `exclude`: workers are not migrated by this run.
 */
export const WORKER_POLICIES = ["hold-dark", "start-dark", "exclude"] as const;
export type WorkerPolicy = (typeof WORKER_POLICIES)[number];
/**
 * N3 / R2 / C6: containers the source API does not list (3 DB containers on the real fleet), found by the host-loop
 * inventory cross-check.
 *  - `block` (default): the preflight gate fails until the owner decides.
 *  - `carry`: the owner wants them migrated. DATA_SEED binds every container the inventory proves carryable (a running PostgreSQL / MySQL /
 *    MariaDB / Redis / KeyDB / Dragonfly the migrator can open with a password it discovers, and a known version) to a NEW database plan
 *    item, which the normal database lane then moves and the env remap points the apps at. One that cannot be carried in full is
 *    refused with a reason code (`inventory.carry-refused-*`) and parks the step until an operator excludes or maps it.
 *  - `skip`: the owner acknowledges they are not migrated (listed as not-carried in the report).
 */
export const UNLISTED_DB_POLICIES = ["block", "carry", "skip"] as const;
export type UnlistedDbPolicy = (typeof UNLISTED_DB_POLICIES)[number];
/** N4 / R14: volumes no container uses (LINKS 0). `block` (default) until the owner says `skip` (acknowledged, not carried, reported). */
export const ORPHAN_VOLUME_POLICIES = ["block", "skip"] as const;
export type OrphanVolumePolicy = (typeof ORPHAN_VOLUME_POLICIES)[number];

/** Why a step is waiting, as stored in `WaitSpec.kind`. */
export const WAIT_KINDS = ["operator", "approval", "timer"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

/**
 * What an approval requires the human to type (checked server-side by the facade against the live names).
 * `target-servers` / `target-servers+source-host` name EVERY target server of a multi-host run ({@link confirmServerNames}).
 * A handler that still asks for `target-server` on a run with more than one target server is upgraded by the engine to
 * `target-servers` ({@link upgradeConfirmKind}), so the point-of-no-return confirmation can never name only some of the hosts.
 */
export const CONFIRM_KINDS = ["none", "run-id", "target-server", "target-servers", "target-server+source-host", "target-servers+source-host", "source-host"] as const;
export type ConfirmKind = (typeof CONFIRM_KINDS)[number];

/** Units of {@link StepProgress}; the web maps them to `migrationRun.units.<unit>`. */
export const PROGRESS_UNITS = ["item", "byte", "volume", "host", "app", "database", "bucket", "second"] as const;
export type ProgressUnit = (typeof PROGRESS_UNITS)[number];

/**
 * The resources an operator can attach to a step with `POST /steps/:key/attach`. `host-inventory` (grup-7) is a stored
 * host-loop inventory snapshot of the run (the runner/inventory lane owns its table and ingest route).
 */
export const ATTACH_KINDS = ["object-migration", "host-inventory"] as const;
export type AttachKind = (typeof ATTACH_KINDS)[number];

/**
 * Which source-host command `POST /steps/:key/command` mints (and which one an operator {@link WaitSpec} offers):
 *  - `migrator`: the classic one-line migrator bootstrap of ONE source host (default, unchanged).
 *  - `host-loop`: the single script that loops over every source host from the Coolify host (`sourceRunner: coolify-host-loop`).
 *  - `inventory`: the read-only inventory/probe script (containers, volumes, bind sizes, host facts), run per host or looped.
 */
export const COMMAND_KINDS = ["migrator", "host-loop", "inventory"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** What caused the engine to enter a step (see {@link StepContext.trigger}). */
export const DRIVE_TRIGGERS = ["enter", "tick", "retry", "approve", "evidence", "attach", "timer", "recover"] as const;
export type DriveTrigger = (typeof DRIVE_TRIGGERS)[number];

/** The evidence of a step nobody touched. */
export const EMPTY_STEP_EVIDENCE: StepEvidence = Object.freeze({ attestations: [], attachments: [] }) as unknown as StepEvidence;

/** A PONR approval is valid for 30 min only (design 10); other approvals do not expire unless the binding says so. */
export const PONR_APPROVAL_TTL_SEC = 30 * 60;
/** Default observe window after CUTOVER (design step 12). */
export const DEFAULT_OBSERVE_MINUTES = 30;
/** Default minimum run age before DECOMMISSION can be armed (design 4). */
export const DEFAULT_DECOMMISSION_MIN_AGE_HOURS = 72;

/** Lower-case dotted/dashed code: the stable identifier the web localizes. */
export const RUN_CODE_RE = /^[a-z0-9]+([.-][a-z0-9]+)*$/;
export const isRunCode = (v: unknown): v is string => typeof v === "string" && v.length <= 80 && RUN_CODE_RE.test(v);

// ───────────────────────────── static step manifest ─────────────────────────────

/** Static, handler-independent facts about a step. The engine creates step rows from it, views render from it. */
export interface StepManifestEntry {
  readonly idx: number;
  /** Primary mode, see {@link StepKind}. A registered handler's `kind` MUST equal it (the registry asserts). */
  readonly kind: StepKind;
  /** A registered handler's `rollback` MUST equal it (the registry asserts). */
  readonly rollback: RollbackClass;
  /** Lane that owns the handler: A = run core + import side, B = data/freeze/verify, C = cutover side. */
  readonly lane: "A" | "B" | "C";
  /** True only for DECOMMISSION: never auto-advanced into; armed by its own route. */
  readonly manual?: true;
  /** `POST /steps/:key/skip` is accepted only for these (DATA_SEED: the rehearsal is optional). */
  readonly skippable?: true;
  /** The step is the point of no return: `ctx.markPonr()` is only legal inside it. */
  readonly ponr?: true;
}

export const STEP_MANIFEST: Readonly<Record<StepKey, StepManifestEntry>> = {
  PREFLIGHT: { idx: 0, kind: "auto", rollback: "FREE", lane: "A" },
  IMPORT: { idx: 1, kind: "auto", rollback: "UNDOABLE", lane: "A" },
  DNS_PREPARE: { idx: 2, kind: "timer", rollback: "UNDOABLE", lane: "C" },
  DATA_SEED: { idx: 3, kind: "operator", rollback: "UNDOABLE", lane: "B", skippable: true },
  FREEZE: { idx: 4, kind: "approval", rollback: "UNDOABLE", lane: "B" },
  DATA_FINAL: { idx: 5, kind: "operator", rollback: "UNDOABLE", lane: "B" },
  REMAP_ENV: { idx: 6, kind: "auto", rollback: "UNDOABLE", lane: "A" },
  DEPLOY_DARK: { idx: 7, kind: "auto", rollback: "UNDOABLE", lane: "A" },
  TLS_PREISSUE: { idx: 8, kind: "auto", rollback: "UNDOABLE", lane: "C" },
  VERIFY: { idx: 9, kind: "approval", rollback: "FREE", lane: "B" },
  CUTOVER: { idx: 10, kind: "auto", rollback: "LOSSY_AFTER_PONR", lane: "C", ponr: true },
  OBSERVE: { idx: 11, kind: "timer", rollback: "LOSSY_AFTER_PONR", lane: "C" },
  FINALIZE: { idx: 12, kind: "auto", rollback: "IRREVERSIBLE", lane: "C" },
  DECOMMISSION: { idx: 13, kind: "approval", rollback: "IRREVERSIBLE", lane: "C", manual: true },
};

/** Position of a step in the flow. */
export const stepIndex = (key: StepKey): number => STEP_MANIFEST[key].idx;
/** The step rows a new run gets: all 13 flow steps, plus DECOMMISSION only for `takeover`. */
export const stepKeysForMode = (mode: RunMode): StepKey[] => STEP_KEYS.filter((k) => k !== "DECOMMISSION" || mode === "takeover");
/** The `activeKey` of a real run on its PRIMARY target server. Dry-runs hold none (they write nothing outside their own run rows). */
export const activeKeyFor = (targetServerId: string): string => `srv:${targetServerId}`;

// ───────────────────────────── multi-host runs (grup-7, C1/R12/Q4) ─────────────────────────────

/** A run maps at most this many source servers (the real fleet has 24 hosts; 3-6 per project). */
export const SERVER_MAP_MAX = 64;

/** What the server-map helpers read of a run: the snapshot, a DB row mapped to it, or any `Pick` of them. */
export interface ServerMapped {
  /** The default/fallback target: used for every source server that has no `serverMap` entry. */
  readonly targetServerId: string;
  /** Source server (Coolify server uuid) to Tugra target server id. Absent/empty = a classic single-target run. */
  readonly serverMap?: Readonly<Record<string, string>> | null;
}

/** Own-property lookup: a source ref like `__proto__` or `constructor` can never resolve through the prototype chain. */
const own = (o: Readonly<Record<string, string>>, k: string): string | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/**
 * The Tugra target server for a resource that lives on source server `sourceServerRef` (a Coolify server uuid, the
 * `serverRef` of an importer plan item). Resolution: the mapped server, else the run's default `targetServerId`.
 * `null`/`undefined`/unknown refs fall back to the default (a single-target run therefore resolves everything to it).
 */
export function targetServerFor(run: ServerMapped, sourceServerRef: string | null | undefined): string {
  if (!sourceServerRef || !run.serverMap) return run.targetServerId;
  return own(run.serverMap, sourceServerRef) ?? run.targetServerId;
}

/** Every Tugra target server of the run: the default first, then the mapped ones in map order, each once. */
export function targetServerIdsOf(run: ServerMapped): string[] {
  const out: string[] = [run.targetServerId];
  for (const id of Object.values(run.serverMap ?? {})) if (!out.includes(id)) out.push(id);
  return out;
}

/** True when the run places resources on more than the default server. */
export const isMultiTarget = (run: ServerMapped): boolean => targetServerIdsOf(run).length > 1;

/**
 * The server ids a REAL run locks (one live run per target server): every target server, default included. Dry-runs lock none.
 * The store keeps `activeKey` for the default server (backward compatible) and one lock row per id returned here.
 */
export const lockServerIdsFor = (run: ServerMapped, dryRun: boolean): string[] => (dryRun ? [] : targetServerIdsOf(run));

/**
 * The source servers a run maps, in map order, each with its target: the per-host list of the `coolify-host-loop` runner and
 * of the per-host inventory. A run without a `serverMap` has no explicit hosts (the importer plan names them).
 */
export function hostLoopTargets(run: ServerMapped): Array<{ sourceServerRef: string; targetServerId: string }> {
  return Object.entries(run.serverMap ?? {}).map(([sourceServerRef, targetServerId]) => ({ sourceServerRef, targetServerId }));
}

/**
 * The source servers of `refs` that a NON-EMPTY serverMap does not map (they would silently land on the default target).
 * A single-target run (no map) returns []: there everything goes to the default by design.
 */
export function unmappedSourceServers(run: ServerMapped, refs: readonly string[]): string[] {
  const map = run.serverMap;
  if (!map || Object.keys(map).length === 0) return [];
  return [...new Set(refs)].filter((r) => own(map, r) === undefined);
}

/**
 * The exact text a human types to confirm an approval that names target servers: the DISTINCT server names, sorted by code
 * point, joined with `", "`. Sorting makes the text independent of map order; the web and CLI show this expected string.
 */
export const confirmServerNames = (names: readonly string[]): string => [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(", ");

/** Upgrade a handler's confirm kind for a run with `targetCount` target servers (see {@link CONFIRM_KINDS}). */
export function upgradeConfirmKind(kind: ConfirmKind, targetCount: number): ConfirmKind {
  if (targetCount <= 1) return kind;
  if (kind === "target-server") return "target-servers";
  if (kind === "target-server+source-host") return "target-servers+source-host";
  return kind;
}

// ───────────────────────────── run option resolvers (grup-7) ─────────────────────────────

/**
 * Options of the `coolify-host-loop` runner. Paths and numbers only: the hub never stores, prints or reads a private key (the
 * script uses the Coolify host's own key files at `<keyDir>/ssh_key@<serverUuid>`).
 */
export const HOST_LOOP_DEFAULTS = { keyDir: "/data/coolify/ssh/keys", parallel: 1, connectTimeoutSec: 15, retries: 1 } as const;
/** `options.hostLoop` with every default filled in. */
export const hostLoopOf = (o: Pick<RunOptions, "hostLoop">): { keyDir: string; parallel: number; connectTimeoutSec: number; retries: number } => ({ ...HOST_LOOP_DEFAULTS, ...(o.hostLoop ?? {}) });

/**
 * C14 / R30: which imported compose SERVICES (a search engine, a document converter, an object store) DEPLOY_DARK starts. The apps of
 * a real stack cannot answer their health path without the services they call, so a service is started BEFORE the apps that need it:
 *  - `dependencies` (default): start the services a dark app depends on (it joined the service's private network) and the services that
 *    serve public domains of their own (cutover hosts), keep the others stopped;
 *  - `none`: start no service (the operator starts them by hand);
 *  - `all`: start every service the import created.
 * A MinIO object store follows the same rule (a dark app that depends on it needs it up); one nobody depends on starts only under
 * `minioPolicy: mirror`. Its buckets arrive through Object migration, never through a volume copy.
 */
export const SERVICE_START_MODES = ["dependencies", "none", "all"] as const;
export type ServiceStartMode = (typeof SERVICE_START_MODES)[number];
export const DEFAULT_SERVICE_START: ServiceStartMode = "dependencies";
export const serviceStartOf = (o: Pick<RunOptions, "serviceStart">): ServiceStartMode => o.serviceStart ?? DEFAULT_SERVICE_START;

/** Builds started at once per target server during DEPLOY_DARK / `earlyBuild` (R25: the real hosts have 2 CPU / 4 GB). */
export const DEFAULT_DEPLOY_CONCURRENCY = 1;
export const deployConcurrencyOf = (o: Pick<RunOptions, "deployConcurrency">): number => o.deployConcurrency ?? DEFAULT_DEPLOY_CONCURRENCY;

/**
 * What DATA_SEED / DATA_FINAL do with a database whose dump exceeds the artifact route's cap and that has no physical lane:
 * `stream-logical` (default) moves it as a streamed dump (parts with a sha256 each, any size; it runs inside the freeze window, so
 * the window estimate carries it); `refuse` is the operator's opt-in to stop instead: the capability matrix fails with a
 * `no-lane` verdict and nothing is moved for that database. No size is ever refused unless the run (or the hub's optional
 * `MIGRATION_VX_MAX_DUMP_BYTES`) says so.
 */
export const LARGE_DB_MODES = ["refuse", "stream-logical"] as const;
export type LargeDbMode = (typeof LARGE_DB_MODES)[number];
export const DEFAULT_LARGE_DB_MODE: LargeDbMode = "stream-logical";
export const largeDbModeOf = (o: Pick<RunOptions, "largeDbMode">): LargeDbMode => o.largeDbMode ?? DEFAULT_LARGE_DB_MODE;

// ───────────────────────────── source version (grup-7, R4/C18) ─────────────────────────────

/**
 * The source versions a run is validated against. `min` is the oldest version a real fleet is proven on (Coolify 4.1.2, the
 * fleet's own); `maxTested` the newest the importer parity work targeted (4.7.5). Dokploy has no range yet (its steps are
 * not built): it is `unchecked`.
 */
export const SOURCE_VERSION_SUPPORT: Readonly<Partial<Record<"coolify" | "dokploy", { readonly min: string; readonly maxTested: string }>>> = {
  coolify: { min: "4.1.2", maxTested: "4.7.5" },
};
/**
 * `supported`: inside the range. `newer`: above `maxTested` (untested: warn, ackable). `too-old`: below `min` (block).
 * `unknown`: no version or not parseable (fails wherever data would move). `unchecked`: the source kind has no range.
 */
export const SOURCE_VERSION_VERDICTS = ["supported", "newer", "too-old", "unknown", "unchecked"] as const;
export type SourceVersionVerdict = (typeof SOURCE_VERSION_VERDICTS)[number];
/** A stored source version is a short printable token. */
export const SOURCE_VERSION_RE = /^[\x21-\x7e]{1,64}$/;

interface ParsedVersion {
  readonly n: readonly [number, number, number];
  /** `4.0.0-beta.442`: a pre-release sorts BEFORE the same x.y.z without one. */
  readonly pre: boolean;
}

/** Parse `v4.1.2`, `4.1.2`, `4.0.0-beta.442`, `4.7` (patch 0). Returns null for anything else. */
export function parseSourceVersion(v: string | null | undefined): ParsedVersion | null {
  if (!v) return null;
  const m = /^v?(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?(?:([-+])[0-9A-Za-z.+-]{0,40})?$/.exec(v.trim());
  if (!m) return null;
  return { n: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)], pre: m[4] === "-" };
}

/** Negative when `a < b`, 0 when equal, positive when `a > b`; null when either side does not parse. */
export function compareSourceVersions(a: string, b: string): number | null {
  const x = parseSourceVersion(a);
  const y = parseSourceVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
}

/** Classify a source version against {@link SOURCE_VERSION_SUPPORT} (see {@link SourceVersionVerdict}). */
export function classifySourceVersion(kind: "coolify" | "dokploy", version: string | null | undefined): SourceVersionVerdict {
  const range = SOURCE_VERSION_SUPPORT[kind];
  if (!range) return "unchecked";
  if (!parseSourceVersion(version)) return "unknown";
  if ((compareSourceVersions(version as string, range.min) ?? 0) < 0) return "too-old";
  if ((compareSourceVersions(version as string, range.maxTested) ?? 0) > 0) return "newer";
  return "supported";
}

// ───────────────────────────── actor ─────────────────────────────

/**
 * How the caller reached the API. `mcp` exists because MCP tools call the facade directly (not over HTTP) and the PONR
 * and decommission approvals are REFUSED for it with 403 `human-confirmation-required` (design 8, security rule).
 */
export type RunChannel = "session" | "pat" | "mcp";

/** The authenticated caller handed to every {@link MigrationRunsFacade} method. */
export interface RunActor {
  readonly userId: string;
  /** Granted API-token scopes (`["*"]` for a browser session). The facade re-checks the ones it needs. */
  readonly scopes: readonly string[];
  readonly channel: RunChannel;
}

/** Build the actor of an HTTP request from the controller's `AuthUser` (a PAT carries a `tokenId`, a session does not). */
export const runActorFromAuth = (u: { userId: string; scopes: readonly string[]; tokenId?: string }): RunActor => ({
  userId: u.userId,
  scopes: u.scopes,
  channel: u.tokenId ? "pat" : "session",
});

// ───────────────────────────── snapshots handed to handlers ─────────────────────────────

/**
 * An immutable, secret-free copy of the `MigrationRun` row as of the start of the engine tick. Handlers must treat it
 * as read-only; changes go through {@link StepContext.patchRun}/{@link StepContext.markPonr} and show up on the next tick.
 */
export interface RunSnapshot {
  readonly id: string;
  readonly teamId: string;
  /** The creator: the only user who drives the run. Services are called as this user (they re-check permissions). */
  readonly actorId: string;
  /** The default target server: every source server that {@link serverMap} does not map lands here. */
  readonly targetServerId: string;
  /**
   * Source server (Coolify server uuid) to Tugra target server id, the multi-host placement of the run (grup-7). `{}` for a
   * classic single-target run. Never read it directly to place a resource: use {@link StepContext.targetFor}.
   */
  readonly serverMap: Readonly<Record<string, string>>;
  readonly sourceKind: "coolify" | "dokploy";
  /**
   * The source's own version string (`4.1.2`), captured at create (best effort) and refreshed by PREFLIGHT through
   * {@link RunPatch.sourceVersion}; null until known. Judge it with {@link classifySourceVersion}.
   */
  readonly sourceVersion: string | null;
  /** Free label that groups the runs of one migration campaign (fleet dashboard, campaign report); null when none. */
  readonly campaign: string | null;
  /**
   * The source health baseline captured before the run changes anything (R28/R52/R66); null until a handler sets it with
   * {@link RunPatch.sourceBaseline}. VERIFY and OBSERVE compare against it so an app that was already crash-looping on the
   * source is not blamed on Tugra.
   */
  readonly sourceBaseline: SourceBaseline | null;
  /** Source instance host (typed-confirmation target and display). */
  readonly sourceHost: string | null;
  /** `ImportSession` id; null/expired when it must be re-entered (steps that need it go to WAITING). */
  readonly sessionId: string | null;
  /** The CURRENT import `BulkOperation`; null before IMPORT passed. */
  readonly opId: string | null;
  /** Earlier ops redone by an IMPORT retry (oldest first). */
  readonly opHistory: readonly string[];
  readonly planHash: string;
  readonly mode: RunMode;
  readonly topology: RunTopology;
  /**
   * `swap-proxy` only, set by a campaign's in-place wave (never by the create body): the source server is taken over IN PLACE by
   * `CoolifyInPlaceService` (no data copy, no build, the images Coolify built are reused). The data steps and TLS_PREISSUE do not apply,
   * DEPLOY_DARK prepares and tests Tugra's side on a dark proxy, VERIFY is the owner's approval of that test, CUTOVER takes the ports
   * and waits for the new certificates. Absent/false = the classic same-host swap with a data copy.
   */
  readonly inPlace?: boolean;
  /** True: every handler runs `dryRun()` only and must write NOTHING outside the run's own rows. */
  readonly dryRun: boolean;
  readonly promotedFromId: string | null;
  /** The frozen, secret-free apply input (names, placement and ack codes only). */
  readonly applyInput: RunApplyInput;
  readonly options: RunOptions;
  readonly inputs: OwnerInputs;
  readonly status: RunStatus;
  readonly currentStep: StepKey | null;
  /** Set (monotonic) immediately BEFORE the first command that can route stateful production traffic to Tugra. */
  readonly ponrAt: Date | null;
  readonly windowEstimate: WindowEstimate | null;
  readonly freezeStartedAt: Date | null;
  readonly freezeEndedAt: Date | null;
  readonly createdAt: Date;
}

/** The persisted state of one step row as of the start of the tick (including other steps, via {@link StepContext.stepState}). */
export interface StepSnapshot {
  readonly key: StepKey;
  readonly status: StepStatus;
  /** Number of times `act` was entered for this step (incremented by the engine before each `act`). */
  readonly attempt: number;
  readonly gate: GateResult | null;
  /** The stored approval, valid or not; handlers read {@link StepContext.approval} (validated) instead. */
  readonly approval: StepApprovalRecord | null;
  readonly inputHash: string | null;
  readonly progress: StepProgress | null;
  /** Ids only, written by {@link StepContext.recordCompensation} BEFORE the side effect. */
  readonly compensation: Readonly<Record<string, unknown>> | null;
  readonly evidence: StepEvidence;
  readonly wait: WaitSpec | null;
  readonly notBefore: Date | null;
}

/** Run columns a handler may set (everything else is engine-owned). `undefined` = leave unchanged. */
export interface RunPatch {
  /** IMPORT only: the new current op (the engine pushes the replaced one onto `opHistory`). */
  readonly opId?: string;
  /** DATA_SEED: the estimate that feeds the FREEZE approval and the final report. */
  readonly windowEstimate?: WindowEstimate;
  /** PREFLIGHT: the source's version string (trimmed, a short printable token, see {@link SOURCE_VERSION_RE}); an invalid value is ignored. */
  readonly sourceVersion?: string;
  /** PREFLIGHT: the source health baseline. Ignored once FREEZE opened the window (a baseline taken after the stop would be wrong). */
  readonly sourceBaseline?: SourceBaseline;
  /** FREEZE: the downtime window opened (set once, first call wins). */
  readonly freezeStartedAt?: Date;
  /** CUTOVER: first host VERIFIED after the flip/swap (set once, first call wins) => measured downtime. */
  readonly freezeEndedAt?: Date;
}

/** An event a handler appends to the run's append-only event log. Codes + params only. */
export interface RunEventInput {
  readonly stepKey?: StepKey | null;
  readonly level: EventLevel;
  readonly code: string;
  readonly params?: CodeParams;
  /** Defaults to null for engine/handler events; the engine sets the acting user on human-triggered ones. */
  readonly actorId?: string | null;
}

/** The engine's own event codes (handlers add theirs with their kebab-case step prefix). */
export const ENGINE_EVENT_CODES = [
  "run.created",
  "run.started",
  "run.promoted",
  "run.paused",
  "run.resumed",
  "run.waiting",
  "run.failed",
  "run.completed",
  "run.dry-run-done",
  "run.abort.requested",
  "run.aborted",
  "run.cleanup.started",
  "run.rolled-back",
  "run.reverse.started",
  "run.reversed",
  "run.ponr.reached",
  "run.auth-lost",
  "run.recovered",
  "run.input.set",
  "run.session.refreshed",
  "run.source-version",
  "step.entered",
  "step.waiting",
  "step.passed",
  "step.failed",
  "step.skipped",
  "step.retry",
  "step.compensated",
  "step.evidence.added",
  "step.attached",
  "step.command.issued",
  "approval.accepted",
  "approval.void",
  "approval.expired",
] as const;

/**
 * What a handler sees and may do during one engine tick of one step. Every method that writes is idempotent per call
 * and is rejected (throws {@link RunLeaseLostError}) once this hub no longer owns the run's lease.
 */
export interface StepContext {
  readonly run: RunSnapshot;
  readonly step: StepSnapshot;
  /** The run creator. Pass `actor.userId` to every existing service call. */
  readonly actor: { readonly userId: string };
  /** This hub process's boot id (`DeployLeaseService.bootId`); use it to build idempotency keys, never persist it. */
  readonly bootId: string;
  /** Why the engine entered the step this tick. */
  readonly trigger: DriveTrigger;
  /** Mirror of `run.dryRun`. */
  readonly dryRun: boolean;
  /**
   * The step's approval IF the engine validated it this tick (`boundHash` equals the freshly computed
   * `ApprovalBinding.inputHash` and it has not expired); otherwise null. Only meaningful for handlers that implement
   * {@link StepHandler.approvalBinding}.
   */
  readonly approval: StepApprovalRecord | null;
  /** Aborted when the run is paused/aborted or the lease is lost: long `observe`/`act` calls must return promptly. */
  readonly signal: AbortSignal;
  /** The engine clock (injectable in tests). */
  now(): Date;
  /**
   * The Tugra target server for a resource that lives on source server `sourceServerUuid` (the plan item's `serverRef`):
   * the run's `serverMap` entry, else the default `run.targetServerId`. EVERY handler that touches a target server must
   * resolve it through this (never `run.targetServerId` directly) so multi-host runs place and verify per host.
   */
  targetFor(sourceServerUuid: string | null | undefined): string;
  /** Every Tugra target server of the run (default first, each once): scope per-server work, capability grants and cleanups to these. */
  readonly targetServerIds: readonly string[];
  /** Read-only view of any step of the run (e.g. CUTOVER reads VERIFY's approval hash). */
  stepState(key: StepKey): StepSnapshot;
  /** Throws {@link RunLeaseLostError} if this hub no longer owns the run. Call before an irreversible effect. */
  assertLease(): Promise<void>;
  /** Append to the event log. */
  emit(event: RunEventInput): Promise<void>;
  /** Replace the step's progress (refs to existing tables, never copies). */
  setProgress(progress: StepProgress): Promise<void>;
  /**
   * Merge `patch` into the step's `compensation` JSON (ids only, no secrets). MUST be awaited BEFORE the side effect
   * it describes, so a crash right after the effect still leaves `compensate` the ids it needs.
   */
  recordCompensation(patch: Readonly<Record<string, unknown>>): Promise<void>;
  /** Set the {@link RunPatch} columns (monotonic where documented). */
  patchRun(patch: RunPatch): Promise<void>;
  /**
   * Persist `ponrAt` (monotonic, idempotent: returns the existing instant when already set) and emit `run.ponr.reached`.
   * Legal only inside the step whose manifest entry has `ponr: true` (CUTOVER) and never in a dry-run. A handler MUST
   * await it before issuing the first flip/swap command that can route a stateful host to Tugra: the engine's crash
   * tests assert that no DNS/proxy command is ever issued while `ponrAt` is unset.
   */
  markPonr(): Promise<Date>;
}

// ───────────────────────────── gates ─────────────────────────────

/**
 * Build a {@link GateResult} from its checks. Rules (the engine relies on them, do not re-implement):
 *  - `fail` blocks, unless the check is `acked`.
 *  - `unknown` blocks by default (`unknownFails: true`): unknown means FAIL wherever data would move. A handler whose
 *    gate never gates data movement (pure info) may pass `{ unknownFails: false }`.
 *  - `warn` and `pass` never block.
 */
export function makeGate(checks: readonly GateCheck[], opts: { unknownFails?: boolean; wait?: WaitSpec } = {}): GateResult {
  const unknownFails = opts.unknownFails ?? true;
  const passed = checks.every((c) => c.acked === true || c.status === "pass" || c.status === "warn" || (c.status === "unknown" && !unknownFails));
  return { passed, checks: [...checks], ...(opts.wait && !passed ? { wait: opts.wait } : {}) };
}

/** A gate with no checks that passes (a step with nothing to verify). */
export const PASSING_GATE: GateResult = Object.freeze({ passed: true, checks: [] }) as GateResult;

/** True when a gate only fails because of `unknown` checks (the UI offers "re-check" instead of "fix"). */
export const gateOnlyUnknown = (g: GateResult): boolean => !g.passed && g.checks.every((c) => c.status !== "fail" || c.acked === true);

// ───────────────────────────── handler results ─────────────────────────────

/**
 * What a step has already done, read from the world (never from memory). Handlers extend it with their own facts and
 * pass the same object to `preGate`/`act`/`postGate`. `progress`, when set, is persisted by the engine.
 */
export interface Observation {
  readonly progress?: StepProgress;
}

/** The result of {@link StepHandler.act}. */
export type ActResult =
  /** The effect finished. The engine re-`observe`s and evaluates `postGate`. */
  | { readonly outcome: "done" }
  /** The effect is running outside this call (fan-out, vx transfer, object migration): re-tick after `pollAfterMs` (clamped to 1 s .. 60 s). */
  | { readonly outcome: "continue"; readonly pollAfterMs: number }
  /** Nothing more the hub can do now: park the step in the matching WAITING_* status. */
  | { readonly outcome: "wait"; readonly wait: WaitSpec }
  /** A deterministic failure. `retryable` only decides which actions the view offers; the engine never auto-retries. */
  | { readonly outcome: "fail"; readonly code: string; readonly params?: CodeParams; readonly retryable: boolean };

/** What `compensate` achieved. */
export interface CompResult {
  /**
   *  - `done`: everything this step did is undone.
   *  - `nothing-to-do`: this step has nothing to undo for the requested `how`.
   *  - `manual`: the hub cannot do it (e.g. `manual` source controller): `manual` lists what the operator must do.
   *  - `failed`: the engine marks the run FAILED (code) and keeps the compensation data for a retry.
   */
  readonly outcome: "done" | "nothing-to-do" | "manual" | "failed";
  readonly code?: string;
  readonly params?: CodeParams;
  /** Printed steps for the operator (shown in the view and the report). Codes + params only. */
  readonly manual?: readonly { readonly code: string; readonly params?: CodeParams }[];
}

/**
 * Why `compensate` is called. The engine invokes it in REVERSE step order over the steps that are not PENDING/SKIPPED:
 *  - `abort` (pre-PONR, `POST /abort`): make Coolify authoritative again and leave the Tugra copies stopped: cancel
 *    in-flight transfers and object migrations, revoke the token and capability grant, restart the RECORDED frozen
 *    source containers (or return `manual`), restore TTLs, stop the Tugra dark apps/DBs, undo the env remap. Never
 *    deletes data. Steps with rollback `FREE` or `IRREVERSIBLE` return `nothing-to-do`.
 *  - `cleanup` (after abort, optional, `POST /cleanup`): remove Tugra-side created resources. Only IMPORT acts (via
 *    `executor.rollback`, honouring `includeData` + typed names); every other handler returns `nothing-to-do`.
 *  - `reverse` (after PONR, `POST /reverse`): the lossy reverse (DNS ledger restore / proxy swap reverse). Only
 *    `LOSSY_AFTER_PONR` handlers act (CUTOVER; OBSERVE returns `nothing-to-do`); it always runs behind the
 *    data-loss acknowledgement.
 * `compensate` MUST be idempotent and MUST read the ids it needs from `ctx.step.compensation`.
 */
export type CompensateHow = "abort" | "cleanup" | "reverse";

// ───────────────────────────── the handler contract ─────────────────────────────

/**
 * One step of the flow. Implementations live in their lane's module, are plain Nest providers, and register themselves
 * with the {@link StepHandlerRegistry} in `onModuleInit`.
 *
 * Normative engine loop per tick (lane A implements, the others rely on it):
 * ```
 * if !applicable(run)                 -> step SKIPPED (code step.not-applicable)
 * if dryRun                           -> items = dryRun(ctx); record them as progress.dryRun; derive a gate; never act()
 * obs = observe(ctx)
 * if postGate(ctx, obs).passed        -> step PASSED (the effect already holds: idempotent resume)
 * binding = approvalBinding?(ctx, obs)-> if present, validate the stored approval against it (boundHash equal, unexpired,
 *                                        required acks given) and expose it as ctx.approval; otherwise ctx.approval = null
 * pre = preGate(ctx, obs)             -> reads ctx.approval?.acks to mark ackable checks `acked`
 * if !pre.passed                      -> WAITING_* from pre.wait (default WAITING_OPERATOR) with pre.checks as reasons
 * if binding && ctx.approval == null  -> WAITING_APPROVAL (event approval.void when a stored approval no longer matches)
 * res = act(ctx, obs)                 -> attempt++ ; then per ActResult (done => re-observe + postGate; a postGate that
 *                                        still fails after `done` fails the step with code step.post-gate-failed)
 * ```
 * Rules every handler must follow:
 *  - NEVER trust memory: after a hub restart `observe` rebuilds the picture from the DB and the world.
 *  - `act` is idempotent. It may be re-entered after a crash at any line, so it must `ctx.recordCompensation` BEFORE
 *    each side effect, use idempotency keys derived from `run.id` (never from `ctx.bootId`), and tolerate "already done".
 *  - A WAITING_OPERATOR step is only re-`observe`d on each tick; `act` is re-entered only on `retry`, `evidence`,
 *    `attach`, `approve` or when a previously blocked `preGate` now passes. WAITING_TIMER re-enters `act` once
 *    `notBefore` passed. So `act` of an operator step usually returns `wait` and the progress comes from `observe`.
 *  - `preGate`/`postGate` are PURE and synchronous: they only read `obs` and `ctx` (inputs, options, step state).
 *  - Throw {@link StepFailure} for deterministic failures; any other thrown error becomes code `step.internal-error`
 *    (the raw message is logged, never stored or shown).
 *  - In a dry-run NOTHING outside the run's own rows is written: only `dryRun` is called.
 */
export interface StepHandler<O extends Observation = Observation> {
  readonly key: StepKey;
  /** Primary mode; must equal `STEP_MANIFEST[key].kind`. */
  readonly kind: StepKind;
  /** Must equal `STEP_MANIFEST[key].rollback`. */
  readonly rollback: RollbackClass;
  /** True when `POST /steps/:key/skip` may skip it; must equal `STEP_MANIFEST[key].skippable === true`. */
  readonly skippable?: boolean;

  /** Mode/topology/options switches: false makes the engine mark the step SKIPPED (swap-proxy skips DNS_PREPARE, ...). Pure. */
  applicable(run: RunSnapshot): boolean;
  /** Read-only projection of what the step WOULD do. Required of every handler (return one `info` item for "nothing to project"). */
  dryRun(ctx: StepContext): Promise<DryRunItem[]>;
  /** What is already true in the world and the DB. Idempotent, side-effect free. */
  observe(ctx: StepContext): Promise<O>;
  /** Preconditions to act (pure). A failed gate parks the step; `wait` says for what. */
  preGate(ctx: StepContext, obs: O): GateResult;
  /** Optional: the approval this step needs right now, or null when none is needed (e.g. REMAP_ENV with nothing manual). */
  approvalBinding?(ctx: StepContext, obs: O): Promise<ApprovalBinding | null>;
  /** Side effects. See the engine loop for the idempotency rules. */
  act(ctx: StepContext, obs: O): Promise<ActResult>;
  /** Verification that the step's effect holds (pure). Must be false when nothing has been done yet. */
  postGate(ctx: StepContext, obs: O): GateResult;
  /** Undo for `how` (see {@link CompensateHow}). Idempotent. */
  compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult>;
}

/** Registry element type: the engine only needs the base observation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStepHandler = StepHandler<any>;

/**
 * A deterministic step failure. `code` is a {@link RUN_CODE_RE} code, `params` JSON-safe and secret-free. This is the
 * ONLY error text-free channel: the message of any other thrown error never reaches the DB, events or views.
 */
export class StepFailure extends Error {
  constructor(
    readonly code: string,
    readonly params?: CodeParams,
    readonly retryable = false,
  ) {
    super(code);
    this.name = "StepFailure";
    if (!isRunCode(code)) throw new Error(`invalid step failure code: ${code}`);
  }
}

/** Thrown by `StepContext` writers when this hub lost the run's lease (another boot adopted it). Handlers must not catch it. */
export class RunLeaseLostError extends Error {
  constructor(readonly runId: string) {
    super(`lease lost for run ${runId}`);
    this.name = "RunLeaseLostError";
  }
}

// ───────────────────────────── registry ─────────────────────────────

/**
 * Nest injection token of the handler registry. The registry module is `@Global()`, so lane modules (the data and
 * cutover step modules, which are imported BY the core module) inject it without importing anything:
 * ```ts
 * constructor(@Inject(STEP_HANDLERS) private readonly registry: StepHandlerRegistry) {}
 * onModuleInit() { this.registry.register(this); }  // or one provider registering all of the lane's handlers
 * ```
 */
export const STEP_HANDLERS = Symbol("MIGRATION_RUN_STEP_HANDLERS");

/** The handler registry (implemented in `step-handler.registry.ts`). */
export interface StepHandlerRegistry {
  /** Throws on an unknown key, a duplicate key, or a handler whose `kind`/`rollback`/`skippable` differs from the manifest. */
  register(handler: AnyStepHandler): void;
  get(key: StepKey): AnyStepHandler | undefined;
  /** Like `get` but throws when missing. */
  require(key: StepKey): AnyStepHandler;
  /** Registered handlers in step order. */
  list(): AnyStepHandler[];
  /** Flow keys (for `mode`) that have no handler yet: the engine refuses to start a REAL run while this is non-empty. */
  missing(mode?: RunMode): StepKey[];
}

// ───────────────────────────── the facade ─────────────────────────────

/** Nest injection token of the facade the controller (and MCP tools) use. Lane A binds the real service to it. */
export const MIGRATION_RUNS_FACADE = Symbol("MIGRATION_RUNS_FACADE");

/**
 * What only the hub's own services (a campaign) may set on a new run; the HTTP body cannot carry it. `inPlace` marks a swap-proxy
 * run as an in-place takeover ({@link RunSnapshot.inPlace}).
 */
export interface RunCreateInternal {
  readonly inPlace?: boolean;
}

/**
 * The service port behind every REST route (design 8) and the MCP tools. One method per route, in the same order.
 * Every method re-checks authorization from `actor` (creator-only ownership, team permissions `apps:config` and
 * `databases` on the run's team, scope per route) and returns the fresh, secret-free {@link MigrationRunView} unless
 * stated otherwise. Errors are the usual Nest HTTP exceptions with a stable machine code in the message:
 * 404 unknown/foreign run, 409 illegal state/stale hash, 403 `human-confirmation-required` (MCP on PONR/decommission),
 * 400 bad confirmation name. Until lane A binds the real service the stub facade answers 501 to every call.
 */
export interface MigrationRunsFacade {
  /** `POST /migration-runs`: validate, freeze the apply input, create the run + its step rows (+ an immediate dry-run projection when `dryRun`). 201. */
  create(actor: RunActor, body: CreateMigrationRunInput, internal?: RunCreateInternal): Promise<MigrationRunView>;
  /** `GET /migration-runs`: the actor's runs on teams they belong to, newest first. */
  list(actor: RunActor, query: ListMigrationRunsQuery): Promise<MigrationRunSummary[]>;
  /** `GET /migration-runs/:id` */
  get(actor: RunActor, id: string): Promise<MigrationRunView>;
  /** `GET /migration-runs/:id/events?afterSeq=` polling cursor. */
  events(actor: RunActor, id: string, query: RunEventsQuery): Promise<RunEventsPage>;
  /**
   * `POST /migration-runs/:id/start`: QUEUED -> RUNNING. On a `DRY_RUN_DONE` run it PROMOTES: creates a NEW real run
   * (frozen inputs copied, `planHash` re-validated, `promotedFromId` set) and returns THAT run, whose `id` differs from `id`.
   */
  start(actor: RunActor, id: string, body: StartRunInput): Promise<MigrationRunView>;
  /** `POST /:id/steps/:key/approve`. 403 `human-confirmation-required` for `channel === "mcp"` when the binding is `ponr` or the step is DECOMMISSION. */
  approve(actor: RunActor, id: string, key: StepKey, body: StepApproveInput): Promise<MigrationRunView>;
  /** `POST /:id/steps/:key/retry`: FAILED/WAITING step -> re-enter. IMPORT retry = rollback + re-apply on a fresh op (max 2 attempts). */
  retry(actor: RunActor, id: string, key: StepKey, body: StepRetryInput): Promise<MigrationRunView>;
  /** `POST /:id/steps/:key/skip`: only for `skippable` steps. */
  skip(actor: RunActor, id: string, key: StepKey, body: StepSkipInput): Promise<MigrationRunView>;
  /** `POST /:id/steps/:key/evidence`: record an operator attestation for a check the step's WaitSpec listed in `attest`. */
  evidence(actor: RunActor, id: string, key: StepKey, body: StepEvidenceInput): Promise<MigrationRunView>;
  /** `POST /:id/steps/:key/attach`: attach an existing resource (an object migration id) to the step. */
  attach(actor: RunActor, id: string, key: StepKey, body: AttachInput): Promise<MigrationRunView>;
  /**
   * `POST /:id/steps/:key/command`: mint (or reissue) the migration token and return the exact source-host command.
   * The command (with its live token) is returned ONCE. `hubBase` is the request's public base URL, derived by the controller.
   */
  command(actor: RunActor, id: string, key: StepKey, body: RunCommandInput, hubBase: string): Promise<RunCommandResult>;
  /** `POST /:id/inputs`: set or change owner inputs (acmeEmail, allowBind, allowLiveShapeProbe, sourceController); unblocks the step that needed one. */
  setInputs(actor: RunActor, id: string, body: SetRunInputsInput): Promise<MigrationRunView>;
  /** `POST /:id/pause` */
  pause(actor: RunActor, id: string): Promise<MigrationRunView>;
  /** `POST /:id/resume` */
  resume(actor: RunActor, id: string): Promise<MigrationRunView>;
  /** `POST /:id/abort`: before PONR only (409 `run-past-ponr` afterwards). 202. */
  abort(actor: RunActor, id: string, body: AbortRunInput): Promise<MigrationRunView>;
  /** `POST /:id/cleanup`: after ABORTED. `admin` scope. 202. */
  cleanup(actor: RunActor, id: string, body: CleanupRunInput): Promise<MigrationRunView>;
  /** `POST /:id/reverse`: after PONR. `admin` scope. 202. */
  reverse(actor: RunActor, id: string, body: ReverseRunInput): Promise<MigrationRunView>;
  /** `POST /:id/decommission`: takeover only, after FINALIZE. `admin` scope. 202. */
  decommission(actor: RunActor, id: string, body: DecommissionRunInput): Promise<MigrationRunView>;
  /** `POST /:id/source-session`: re-enter the source token (never returned). */
  sourceSession(actor: RunActor, id: string, body: SourceSessionInput): Promise<SourceSessionResult>;
  /** `GET /:id/source-agents`: the source servers a promotion of this finished dry run would refuse on (no online agent). 409 `not-a-finished-dry-run` otherwise. */
  sourceAgents(actor: RunActor, id: string, query: SourceAgentsQuery): Promise<SourceAgentsResult>;
  /** `GET /:id/report?format=json`: the final, secret-free report (built on demand for a run that is not finished yet). */
  report(actor: RunActor, id: string): Promise<RunReport>;
  /** `GET /:id/report?format=md`: the same report rendered as Markdown (codes rendered with the English locale). */
  reportMarkdown(actor: RunActor, id: string): Promise<string>;
}

// ───────────────────────────── owner inputs ─────────────────────────────

/** The resolved value type of each owner input. */
export interface OwnerInputValues {
  acmeEmail: string;
  allowBind: boolean;
  allowLiveShapeProbe: boolean;
  sourceController: SourceController;
  minioPolicy: MinioPolicy;
  /** Longest write gap in minutes the owner accepts for append-only feed writers (R42/N2); 0 = no gap accepted. */
  tickGapAcceptMinutes: number;
  workerPolicy: WorkerPolicy;
  unlistedDbPolicy: UnlistedDbPolicy;
  orphanVolumePolicy: OrphanVolumePolicy;
}

/**
 * The value a handler uses when the owner left the question unanswered (design 7, "Default when unknown"). `acmeEmail`
 * has NO default: it blocks TLS_PREISSUE and CUTOVER (and only those), steps 1-8 run without it.
 */
export const OWNER_INPUT_DEFAULTS: { readonly [K in Exclude<OwnerInputKey, "acmeEmail">]: OwnerInputValues[K] } = {
  allowBind: false,
  allowLiveShapeProbe: false,
  sourceController: "manual",
  // grup-7, all fail-closed: an unanswered question holds something back or blocks, it never acts.
  /** Mirror nothing, cut no MinIO-dependent host over. */
  minioPolicy: "hold",
  /** No write gap accepted: a window that would stop an append-only feed writer is blocked until the owner states a tolerance. */
  tickGapAcceptMinutes: 0,
  /** Workers are imported but stay stopped until after CUTOVER. */
  workerPolicy: "hold-dark",
  /** An unlisted DB container blocks preflight until the owner decides. */
  unlistedDbPolicy: "block",
  /** An orphan volume blocks until the owner acknowledges it is not carried. */
  orphanVolumePolicy: "block",
};

/**
 * Resolve an owner input: the answered value, else the documented default, else `undefined` (unknown and no default).
 * A handler reports `undefined` as a gate check with status `unknown` and `ownerInput: key`.
 */
export function resolveOwnerInput<K extends OwnerInputKey>(inputs: OwnerInputs, key: K): OwnerInputValues[K] | undefined {
  const rec = inputs[key] as { value: unknown } | undefined;
  if (rec && rec.value !== "unknown") return rec.value as OwnerInputValues[K];
  return (OWNER_INPUT_DEFAULTS as Record<string, unknown>)[key] as OwnerInputValues[K] | undefined;
}

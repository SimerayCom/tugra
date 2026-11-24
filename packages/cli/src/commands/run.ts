import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { activeClient } from "../session";
import { printJson, printLine, printTable } from "../output";

/**
 * `tugra import run ...`: the guided Coolify/Dokploy -> Tugra migration run (`/migration-runs`). Every sub-command maps
 * 1:1 to one hub route through a pure request builder (unit-tested without a network). Secrets never travel as flags:
 * the source token for `source-session` comes from `$TUGRA_SOURCE_TOKEN`, and object-store credentials never pass
 * through a run at all (create the object migration with `tugra objects create`, then `attach` its id).
 */

/** The env var `source-session` reads the Coolify/Dokploy API token from (never a flag: shell history, process list). */
export const SOURCE_TOKEN_ENV = "TUGRA_SOURCE_TOKEN";

export const RUN_ACTIONS = ["status", "start", "approve", "retry", "skip", "evidence", "attach", "command", "inputs", "pause", "resume", "abort", "cleanup", "reverse", "decommission", "source-session", "report", "events", "safety-hints", "image-pin", "worker-mark"] as const;
export type RunAction = (typeof RUN_ACTIONS)[number];

export const SOURCE_KINDS = ["coolify", "dokploy"] as const;
export const MODES = ["copy", "takeover"] as const;
export const TOPOLOGIES = ["two-box", "swap-proxy"] as const;
export const TTL_POLICIES = ["wait", "skip-ack"] as const;
export const DEPLOY_WAVES = ["single", "earlyStateless", "earlyBuild"] as const;
export const CERT_MODES = ["none", "seed"] as const;
export const SOURCE_RUNNERS = ["operator", "agent", "coolify-host-loop"] as const;
export const COMMAND_KINDS = ["migrator", "host-loop", "inventory"] as const;
export const LARGE_DB_MODES = ["refuse", "stream-logical"] as const;
export const SERVICE_START_MODES = ["dependencies", "none", "all"] as const;
export const MINIO_POLICIES = ["hold", "mirror", "external"] as const;
export const WORKER_POLICIES = ["hold-dark", "start-dark", "exclude"] as const;
export const UNLISTED_DB_POLICIES = ["block", "carry", "skip"] as const;
export const ORPHAN_VOLUME_POLICIES = ["block", "skip"] as const;
export const WORKER_ROLES = ["job-runner", "web", "none"] as const;
export const PIN_EVIDENCE = ["operator-attested", "host-loop-reported"] as const;
/** The hub's limits on a placement map and a host-loop key directory. */
export const SERVER_MAP_MAX = 64;
export const HOST_LOOP_DEFAULT_KEY_DIR = "/data/coolify/ssh/keys";
export const SOURCE_CONTROLLERS = ["manual", "api", "agent"] as const;
export const ROW_COUNT_MODES = ["exact", "estimate"] as const;

/** Statuses after which a run never moves again by itself. */
export const TERMINAL_STATUSES: readonly string[] = ["ABORTED", "ROLLED_BACK", "REVERSED", "COMPLETED", "DRY_RUN_DONE"];
/** `nextAction.kind` values that need a human (as opposed to the hub working, a timer, or nothing left to do). */
export const HUMAN_WAITS: readonly string[] = ["operator", "approval", "session", "gate", "paused", "failed"];

export interface Req {
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: unknown;
}

export interface RunOpts {
  // create
  session?: string;
  sourceKind?: string;
  server?: string;
  planHash?: string;
  environment?: string;
  mode?: string;
  topology?: string;
  dryRun?: boolean;
  mapping?: unknown;
  mappingHash?: string;
  acks?: unknown;
  serviceChoices?: unknown;
  dbDataModes?: unknown;
  reconcile?: boolean;
  ignoreStoredMapping?: boolean;
  saveMapping?: boolean;
  ttlPolicy?: string;
  deployWaves?: string;
  warmDbSeed?: boolean;
  stopSource?: boolean;
  sourceRunner?: string;
  /** Multi-host placement: source server uuid -> Tugra server id (from `--map` and/or `--server-map-file`). */
  serverMap?: Record<string, string>;
  campaign?: string;
  hostLoopKeyDir?: string;
  hostLoopParallel?: number;
  hostLoopConnectTimeout?: number;
  hostLoopRetries?: number;
  deployConcurrency?: number;
  largeDbMode?: string;
  serviceStart?: string;
  certs?: string;
  acceptHttp01Gap?: boolean;
  freezeAt?: string;
  observeMinutes?: number;
  manualFinalize?: boolean;
  batchSize?: number;
  interval?: number;
  dnsCredential?: string;
  healthPath?: string;
  rowCountMode?: string;
  decommissionMinAge?: number;
  stuckOperatorMinutes?: number;
  acmeEmail?: string;
  allowBind?: boolean;
  allowLiveProbe?: boolean;
  sourceController?: string;
  minioPolicy?: string;
  workerPolicy?: string;
  unlistedDbPolicy?: string;
  orphanVolumePolicy?: string;
  // command
  kind?: string;
  // safety hints
  image?: string;
  digest?: string;
  scope?: string;
  evidenceKind?: string;
  remove?: boolean;
  item?: string;
  role?: string;
  // list
  team?: string;
  status?: string;
  active?: boolean;
  limit?: number;
  // events
  afterSeq?: number;
  // step actions
  step?: string;
  hash?: string;
  ack?: string;
  confirm?: string;
  acceptDataRisk?: boolean;
  reason?: string;
  check?: string;
  subject?: string;
  note?: string;
  objectMigration?: string;
  reissue?: boolean;
  includeData?: boolean;
  dataConfirm?: string;
  acknowledgeDataLoss?: boolean;
  token?: string;
  format?: string;
}

const need = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const oneOf = (v: string | undefined, allowed: readonly string[], flag: string): void => {
  if (v !== undefined) need(allowed.includes(v), `${flag} must be one of: ${allowed.join(", ")}`);
};
const int = (v: number | undefined, min: number, max: number, flag: string): void => {
  if (v !== undefined) need(Number.isInteger(v) && v >= min && v <= max, `${flag} must be an integer ${min}-${max}`);
};
const q = (params: Record<string, string | number | boolean | undefined>): string => {
  const parts = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
};
const csv = (v: string | undefined): string[] => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const base = (runId: string): string => `/migration-runs/${encodeURIComponent(runId)}`;
const stepPath = (runId: string, step: string | undefined, action: string): string => {
  need(step && /^[A-Z][A-Z_]*$/.test(step), "the step key is required, e.g. FREEZE (see `tugra import run status`)");
  return `${base(runId)}/steps/${encodeURIComponent(step!)}/${action}`;
};

/** `GET /migration-runs`. */
export function buildListRequest(o: RunOpts): Req {
  int(o.limit, 1, 200, "--limit");
  if (o.campaign !== undefined) validateCampaign(o.campaign);
  return { method: "GET", path: `/migration-runs${q({ teamId: o.team, status: o.status, active: o.active === undefined ? undefined : o.active, campaign: o.campaign, limit: o.limit })}` };
}

/** A campaign label: 1-80 printable characters (the hub trims it). */
function validateCampaign(v: string): void {
  const c = v.trim();
  need(c.length >= 1 && c.length <= 80 && !/\p{Cc}/u.test(c), "--campaign must be 1-80 printable characters");
}

/** The hub's rule for a source server ref in a placement map: printable ASCII, 1-200 characters, never a prototype name. */
const SOURCE_REF_RE = /^[\x21-\x7e]{1,200}$/;

/**
 * Turn repeated `--map <sourceServer>=<targetServerId>` values into a placement map. The source server is the Coolify server
 * uuid; `_` stands for resources whose source host the source did not say. A duplicate source server is refused rather than
 * silently overwritten.
 */
export function parseServerMap(pairs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const p of pairs) {
    const i = p.indexOf("=");
    need(i > 0 && i < p.length - 1, `--map expects <source-server-uuid>=<tugra-server-id>, got "${p}"`);
    const src = p.slice(0, i);
    const dst = p.slice(i + 1).trim();
    need(SOURCE_REF_RE.test(src) && src !== "__proto__" && src !== "constructor" && src !== "prototype", `--map: "${src}" is not a valid source server ref`);
    need(dst.length > 0 && dst.length <= 64, `--map: "${src}" needs a Tugra server id`);
    need(!(src in out), `--map: source server "${src}" is mapped twice`);
    out[src] = dst;
  }
  return { ...out };
}

/** Validate a placement map the way the hub does, before any request is made. */
function validateServerMap(map: Record<string, string>): void {
  const entries = Object.entries(map);
  need(entries.length >= 1, "the server map is empty: pass at least one --map, or leave it out for a single-target run");
  need(entries.length <= SERVER_MAP_MAX, `a server map holds at most ${SERVER_MAP_MAX} source servers`);
  for (const [src, dst] of entries) {
    need(SOURCE_REF_RE.test(src) && src !== "__proto__" && src !== "constructor" && src !== "prototype", `server map: "${src}" is not a valid source server ref`);
    need(typeof dst === "string" && dst.length > 0 && dst.length <= 64, `server map: "${src}" needs a Tugra server id`);
  }
}

/** The hub's keyDir rule for the host-loop runner: absolute, [A-Za-z0-9._/-] only, no `..` segment. */
const validKeyDir = (p: string): boolean => /^\/[A-Za-z0-9._\/-]{0,200}$/.test(p) && !p.split("/").includes("..");

/** `POST /migration-runs`. Only what was asked for is sent; the hub applies the safe defaults. */
export function buildCreateRequest(o: RunOpts): Req {
  need(o.session, "--session <id> is required (the import session, from `POST /import/connect` or the import wizard)");
  need(o.server, "--server <id> is required (the target Tugra server)");
  need(o.planHash && /^[a-f0-9]{32}$/.test(o.planHash), "--plan-hash must be the 32-hex planHash of the plan you reviewed");
  const sourceKind = o.sourceKind ?? "coolify";
  oneOf(sourceKind, SOURCE_KINDS, "--source-kind");
  oneOf(o.mode, MODES, "--mode");
  oneOf(o.topology, TOPOLOGIES, "--topology");
  oneOf(o.ttlPolicy, TTL_POLICIES, "--ttl-policy");
  oneOf(o.deployWaves, DEPLOY_WAVES, "--deploy-waves");
  oneOf(o.certs, CERT_MODES, "--certs");
  oneOf(o.sourceRunner, SOURCE_RUNNERS, "--source-runner");
  oneOf(o.rowCountMode, ROW_COUNT_MODES, "--row-count-mode");
  oneOf(o.sourceController, SOURCE_CONTROLLERS, "--source-controller");
  oneOf(o.largeDbMode, LARGE_DB_MODES, "--large-db-mode");
  oneOf(o.serviceStart, SERVICE_START_MODES, "--service-start");
  oneOf(o.minioPolicy, MINIO_POLICIES, "--minio-policy");
  oneOf(o.workerPolicy, WORKER_POLICIES, "--worker-policy");
  oneOf(o.unlistedDbPolicy, UNLISTED_DB_POLICIES, "--unlisted-db-policy");
  oneOf(o.orphanVolumePolicy, ORPHAN_VOLUME_POLICIES, "--orphan-volume-policy");
  int(o.deployConcurrency, 1, 8, "--deploy-concurrency");
  int(o.hostLoopParallel, 1, 8, "--host-loop-parallel");
  int(o.hostLoopConnectTimeout, 5, 120, "--host-loop-connect-timeout");
  int(o.hostLoopRetries, 0, 5, "--host-loop-retries");
  if (o.campaign !== undefined) validateCampaign(o.campaign);
  if (o.serverMap !== undefined) validateServerMap(o.serverMap);
  const hostLoopFlags = o.hostLoopKeyDir !== undefined || o.hostLoopParallel !== undefined || o.hostLoopConnectTimeout !== undefined || o.hostLoopRetries !== undefined;
  need(!hostLoopFlags || o.sourceRunner === "coolify-host-loop", "the --host-loop-* flags need --source-runner coolify-host-loop");
  if (o.hostLoopKeyDir !== undefined) need(validKeyDir(o.hostLoopKeyDir), "--host-loop-key-dir must be an absolute path of letters, digits and . _ / - without ..");
  int(o.observeMinutes, 0, 4320, "--observe-minutes");
  int(o.batchSize, 1, 25, "--batch-size");
  int(o.interval, 5, 600, "--interval");
  int(o.decommissionMinAge, 0, 24 * 90, "--decommission-min-age");
  int(o.stuckOperatorMinutes, 5, 24 * 60, "--stuck-operator-minutes");
  need((o.mapping === undefined) === (o.mappingHash === undefined), "--mapping-file and --mapping-hash must be sent together (the hash comes from the mapping resolve)");
  if (o.freezeAt !== undefined) need(!Number.isNaN(Date.parse(o.freezeAt)), "--freeze-at must be an ISO-8601 time, e.g. 2026-11-22T02:00:00Z");
  if (o.healthPath !== undefined) need(/^\/[\x21-\x7e]{0,254}$/.test(o.healthPath), "--health-path must start with / and be printable ASCII");

  const options: Record<string, unknown> = {
    ...(o.ttlPolicy ? { ttlPolicy: o.ttlPolicy } : {}),
    ...(o.deployWaves ? { deployWaves: o.deployWaves } : {}),
    ...(o.warmDbSeed ? { warmDbSeed: true } : {}),
    ...(o.stopSource ? { stopSource: true } : {}),
    ...(o.sourceRunner ? { sourceRunner: o.sourceRunner } : {}),
    ...(o.certs ? { certs: o.certs } : {}),
    ...(o.acceptHttp01Gap ? { acceptHttp01Gap: true } : {}),
    ...(o.freezeAt ? { freezeAt: o.freezeAt } : {}),
    ...(o.observeMinutes !== undefined ? { observeMinutes: o.observeMinutes } : {}),
    ...(o.manualFinalize ? { manualFinalize: true } : {}),
    ...(o.batchSize !== undefined ? { batchSize: o.batchSize } : {}),
    ...(o.interval !== undefined ? { intervalSec: o.interval } : {}),
    ...(o.dnsCredential ? { dnsCredentialId: o.dnsCredential } : {}),
    ...(o.healthPath ? { healthPath: o.healthPath } : {}),
    ...(o.rowCountMode ? { rowCountMode: o.rowCountMode } : {}),
    ...(o.decommissionMinAge !== undefined ? { decommissionMinAgeHours: o.decommissionMinAge } : {}),
    ...(o.stuckOperatorMinutes !== undefined ? { stuckOperatorMinutes: o.stuckOperatorMinutes } : {}),
    ...(hostLoopFlags
      ? {
          hostLoop: {
            keyDir: o.hostLoopKeyDir ?? HOST_LOOP_DEFAULT_KEY_DIR,
            ...(o.hostLoopParallel !== undefined ? { parallel: o.hostLoopParallel } : {}),
            ...(o.hostLoopConnectTimeout !== undefined ? { connectTimeoutSec: o.hostLoopConnectTimeout } : {}),
            ...(o.hostLoopRetries !== undefined ? { retries: o.hostLoopRetries } : {}),
          },
        }
      : {}),
    ...(o.deployConcurrency !== undefined ? { deployConcurrency: o.deployConcurrency } : {}),
    ...(o.largeDbMode ? { largeDbMode: o.largeDbMode } : {}),
    ...(o.serviceStart ? { serviceStart: o.serviceStart } : {}),
  };
  const inputs: Record<string, unknown> = {
    ...(o.acmeEmail ? { acmeEmail: o.acmeEmail } : {}),
    ...(o.allowBind !== undefined ? { allowBind: o.allowBind } : {}),
    ...(o.allowLiveProbe !== undefined ? { allowLiveShapeProbe: o.allowLiveProbe } : {}),
    ...(o.sourceController ? { sourceController: o.sourceController } : {}),
    ...policyBody(o),
  };
  return {
    method: "POST",
    path: "/migration-runs",
    body: {
      sessionId: o.session,
      sourceKind,
      targetServerId: o.server,
      planHash: o.planHash,
      ...(o.environment ? { environmentId: o.environment } : {}),
      ...(o.mode ? { mode: o.mode } : {}),
      ...(o.topology ? { topology: o.topology } : {}),
      ...(o.dryRun ? { dryRun: true } : {}),
      ...(o.mapping !== undefined ? { mapping: o.mapping, mappingHash: o.mappingHash } : {}),
      ...(o.acks !== undefined ? { acks: o.acks } : {}),
      ...(o.serviceChoices !== undefined ? { serviceChoices: o.serviceChoices } : {}),
      ...(o.dbDataModes !== undefined ? { dbDataModes: o.dbDataModes } : {}),
      ...(o.reconcile ? { reconcile: true } : {}),
      ...(o.ignoreStoredMapping ? { ignoreStoredMapping: true } : {}),
      ...(o.saveMapping === false ? { saveMapping: false } : {}),
      ...(Object.keys(options).length ? { options } : {}),
      ...(Object.keys(inputs).length ? { inputs } : {}),
      ...(o.serverMap !== undefined ? { serverMap: o.serverMap } : {}),
      ...(o.campaign !== undefined ? { campaign: o.campaign.trim() } : {}),
    },
  };
}

/** The fleet policy owner inputs that were given (an omitted one keeps the hub's fail-closed default). */
function policyBody(o: RunOpts): Record<string, unknown> {
  return {
    ...(o.minioPolicy ? { minioPolicy: o.minioPolicy } : {}),
    ...(o.workerPolicy ? { workerPolicy: o.workerPolicy } : {}),
    ...(o.unlistedDbPolicy ? { unlistedDbPolicy: o.unlistedDbPolicy } : {}),
    ...(o.orphanVolumePolicy ? { orphanVolumePolicy: o.orphanVolumePolicy } : {}),
  };
}

/** The request each per-run action maps to (1:1 with the hub route). */
export function buildRequest(action: RunAction, runId: string, o: RunOpts): Req {
  need(runId, "a run id is required");
  switch (action) {
    case "status":
      return { method: "GET", path: base(runId) };
    case "events":
      int(o.afterSeq, 0, Number.MAX_SAFE_INTEGER, "--after-seq");
      int(o.limit, 1, 500, "--limit");
      return { method: "GET", path: `${base(runId)}/events${q({ afterSeq: o.afterSeq, limit: o.limit })}` };
    case "start":
      return { method: "POST", path: `${base(runId)}/start`, body: o.session ? { sessionId: o.session } : {} };
    case "approve": {
      need(o.hash && /^[a-f0-9]{64}$/.test(o.hash), "--hash <boundHash> is required: the inputHash shown by `status` for the approval you reviewed");
      return {
        method: "POST",
        path: stepPath(runId, o.step, "approve"),
        body: { boundHash: o.hash, acks: csv(o.ack), ...(o.confirm ? { confirmName: o.confirm } : {}), ...(o.acceptDataRisk ? { acceptDataRisk: true } : {}) },
      };
    }
    case "retry":
      return { method: "POST", path: stepPath(runId, o.step, "retry"), body: {} };
    case "skip":
      return { method: "POST", path: stepPath(runId, o.step, "skip"), body: o.reason ? { reason: o.reason } : {} };
    case "evidence":
      need(o.check, "--check <checkId> is required (an id from the step's `attest` list)");
      return { method: "POST", path: stepPath(runId, o.step, "evidence"), body: { checkId: o.check, ...(o.subject ? { subject: o.subject } : {}), ...(o.note ? { note: o.note } : {}) } };
    case "attach":
      need(o.objectMigration, "--object-migration <id> is required (create it with `tugra objects create`)");
      return { method: "POST", path: stepPath(runId, o.step, "attach"), body: { kind: "object-migration", resourceId: o.objectMigration } };
    case "command":
      oneOf(o.kind, COMMAND_KINDS, "--kind");
      return { method: "POST", path: stepPath(runId, o.step, "command"), body: { reissue: o.reissue === true, ...(o.kind ? { kind: o.kind } : {}) } };
    case "inputs": {
      oneOf(o.sourceController, SOURCE_CONTROLLERS, "--source-controller");
      oneOf(o.minioPolicy, MINIO_POLICIES, "--minio-policy");
      oneOf(o.workerPolicy, WORKER_POLICIES, "--worker-policy");
      oneOf(o.unlistedDbPolicy, UNLISTED_DB_POLICIES, "--unlisted-db-policy");
      oneOf(o.orphanVolumePolicy, ORPHAN_VOLUME_POLICIES, "--orphan-volume-policy");
          const body = {
        ...(o.acmeEmail ? { acmeEmail: o.acmeEmail } : {}),
        ...(o.allowBind !== undefined ? { allowBind: o.allowBind } : {}),
        ...(o.allowLiveProbe !== undefined ? { allowLiveShapeProbe: o.allowLiveProbe } : {}),
        ...(o.sourceController ? { sourceController: o.sourceController } : {}),
        ...policyBody(o),
      };
      need(Object.keys(body).length > 0, "give at least one input: --acme-email, --allow-bind, --allow-live-probe, --source-controller, --minio-policy, --worker-policy, --unlisted-db-policy or --orphan-volume-policy");
      return { method: "POST", path: `${base(runId)}/inputs`, body };
    }
    case "pause":
      return { method: "POST", path: `${base(runId)}/pause`, body: {} };
    case "resume":
      return { method: "POST", path: `${base(runId)}/resume`, body: {} };
    case "abort":
      need(o.confirm === runId, "--confirm must equal the run id: an abort makes the source authoritative again and stops the Tugra copies (before the point of no return only)");
      return { method: "POST", path: `${base(runId)}/abort`, body: { confirmName: runId } };
    case "cleanup":
      need(o.confirm === runId, "--confirm must equal the run id: cleanup removes the Tugra-side resources an aborted run created");
      need(!o.dataConfirm || o.includeData, "--data-confirm only applies with --include-data");
      return { method: "POST", path: `${base(runId)}/cleanup`, body: { confirmName: runId, includeData: o.includeData === true, dataConfirmNames: csv(o.dataConfirm) } };
    case "reverse":
      need(o.confirm === runId, "--confirm must equal the run id");
      need(o.acknowledgeDataLoss, "--acknowledge-data-loss is required: a reverse returns traffic to the source but cannot restore data Tugra wrote after the cutover");
      return { method: "POST", path: `${base(runId)}/reverse`, body: { confirmName: runId, acknowledgeDataLoss: true } };
    case "decommission":
      need(o.confirm, "--confirm <source host> is required: decommission stops (never deletes) the source containers");
      return { method: "POST", path: `${base(runId)}/decommission`, body: { confirmName: o.confirm } };
    case "source-session":
      need(o.token, `set $${SOURCE_TOKEN_ENV} (the source API token is never passed as a flag)`);
      return { method: "POST", path: `${base(runId)}/source-session`, body: { token: o.token } };
    case "safety-hints":
      return { method: "GET", path: `${base(runId)}/safety-hints` };
    case "image-pin": {
      need(o.image && /^[A-Za-z0-9][A-Za-z0-9._\/:-]{0,299}$/.test(o.image), "--image <ref> is required: the image as the plan shows it, e.g. repo/app:latest");
      oneOf(o.evidenceKind, PIN_EVIDENCE, "--evidence");
      need(o.scope === undefined || /^[\x21-\x7e]{0,200}$/.test(o.scope), "--scope must be a source server uuid (printable, at most 200 characters)");
      need(o.remove ? o.digest === undefined : !!o.digest && /^sha256:[a-f0-9]{64}$/.test(o.digest), o.remove ? "--remove takes no --digest" : "--digest must be sha256: followed by 64 lower-case hex characters (docker image inspect on the source host)");
      return {
        method: "PUT",
        path: `${base(runId)}/image-pins`,
        body: { pins: [{ image: o.image, scope: o.scope ?? "", digest: o.remove ? null : o.digest, ...(o.evidenceKind ? { evidence: o.evidenceKind } : {}) }] },
      };
    }
    case "worker-mark": {
      need(o.item && /^app:[\x21-\x7e]+$/.test(o.item) && o.item.length <= 340, "--item <itemRef> is required: the plan item of the app, e.g. app:<server>:<ref>");
      need(!!o.role && (WORKER_ROLES as readonly string[]).includes(o.role), `--role must be one of: ${WORKER_ROLES.join(", ")} (none removes the mark)`);
      return { method: "PUT", path: `${base(runId)}/worker-marks`, body: { marks: [{ itemRef: o.item, role: o.role === "none" ? null : o.role }] } };
    }
    case "report":
      oneOf(o.format, ["json", "md"], "--format");
      return { method: "GET", path: `${base(runId)}/report${o.format === "md" ? "?format=md" : ""}` };
  }
}

// ───────────────────────────── rendering ─────────────────────────────

interface RunStepView {
  key: string;
  status: string;
  kind: string;
  attempt: number;
  rollbackClass: string;
  lastError: string | null;
  progress: { done: number; total: number; unit: string } | null;
}
interface ApprovalView {
  inputHash: string;
  ponr: boolean;
  confirm: string;
  ttlSec: number | null;
  requiresDataRisk: boolean;
  ackable: string[];
  requiredAcks: string[];
}
export interface RunView {
  id: string;
  status: string;
  currentStep: string | null;
  mode: string;
  topology: string;
  dryRun: boolean;
  ponrAt: string | null;
  targetServerName: string | null;
  /** Every target server of the run, default first (absent on a hub that predates multi-host runs). */
  targetServers?: Array<{ serverId: string; serverName: string | null; primary: boolean }>;
  serverMap?: Record<string, string>;
  sourceHost: string | null;
  sourceVersion?: string | null;
  sourceVersionVerdict?: string;
  campaign?: string | null;
  baselineAt?: string | null;
  failure: { step: string | null; code: string } | null;
  nextAction: { kind: string; stepKey: string | null; code: string; since: string; notBefore?: string | null; approval?: ApprovalView; attest?: string[]; offersCommand?: boolean };
  windowEstimate: { freezeToFlipSec: number | null } | null;
  measuredDowntimeSec: number | null;
  steps: RunStepView[];
  eventSeq: number;
}
export interface RunEventView {
  seq: number;
  at: string;
  stepKey: string | null;
  level: string;
  code: string;
  params: Record<string, unknown> | null;
}

export const isTerminal = (status: string): boolean => TERMINAL_STATUSES.includes(status);

/** What the human must type for an approval's `confirmName`. */
export function confirmHint(confirm: string, ctx: { runId: string; serverName: string | null; sourceHost: string | null; serverNames?: readonly (string | null)[] }): string | null {
  // a multi-host run names EVERY target server: the distinct names sorted by code point, joined with ", " (what the hub compares)
  const names = ctx.serverNames && ctx.serverNames.length > 0 ? ctx.serverNames : ctx.serverName ? [ctx.serverName] : [];
  const servers = names.length > 0 && names.every((n): n is string => !!n) ? [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(", ") : "<target server names>";
  switch (confirm) {
    case "target-servers":
      return servers;
    case "target-servers+source-host":
      return `${servers} ${ctx.sourceHost ?? "<source host>"}`;
    case "none":
      return null;
    case "run-id":
      return ctx.runId;
    case "target-server":
      return ctx.serverName ?? "<target server name>";
    case "source-host":
      return ctx.sourceHost ?? "<source host>";
    case "target-server+source-host":
      return `${ctx.serverName ?? "<target server name>"} ${ctx.sourceHost ?? "<source host>"}`;
    default:
      return null;
  }
}

/** POSIX single-quote a value so a pasted command passes it as ONE literal argument (no `$(...)`, backtick or quote breakout). */
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** One event as a log line: `12 2026-11-22T02:00:00Z info  FREEZE  step.freeze.started {"hosts":3}`. */
export function formatEvent(e: RunEventView): string {
  const params = e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : "";
  return `${String(e.seq).padStart(4)} ${e.at} ${e.level.padEnd(5)} ${(e.stepKey ?? "-").padEnd(13)} ${e.code}${params}`;
}

/** The human summary of a run: header, what it waits for, the approval to review (if any) and the step table. */
export function formatStatus(v: RunView): string[] {
  const out: string[] = [];
  out.push(`run ${v.id}  ${v.status}${v.dryRun ? "  (dry run)" : ""}  step ${v.currentStep ?? "-"}  ${v.mode}/${v.topology}`);
  const servers = v.targetServers && v.targetServers.length > 1 ? v.targetServers.map((s) => `${s.serverName ?? s.serverId}${s.primary ? " (default)" : ""}`).join(", ") : (v.targetServerName ?? "?");
  out.push(`source ${v.sourceHost ?? "?"} -> target ${servers}   point of no return: ${v.ponrAt ? `reached ${v.ponrAt}` : "not reached"}`);
  if (v.serverMap && Object.keys(v.serverMap).length > 0) {
    const name = (id: string) => v.targetServers?.find((s) => s.serverId === id)?.serverName ?? id;
    out.push(`placement: ${Object.entries(v.serverMap).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([src, dst]) => `${src} -> ${name(dst)}`).join(", ")}`);
  }
  if (v.sourceVersion !== undefined || v.campaign) {
    out.push(`source version: ${v.sourceVersion ?? "not read yet"}${v.sourceVersionVerdict ? ` (${v.sourceVersionVerdict})` : ""}${v.campaign ? `   campaign: ${v.campaign}` : ""}${v.baselineAt !== undefined ? `   health baseline: ${v.baselineAt ?? "not recorded yet"}` : ""}`);
  }
  if (v.windowEstimate?.freezeToFlipSec != null || v.measuredDowntimeSec != null) {
    out.push(`downtime window: estimated ${v.windowEstimate?.freezeToFlipSec ?? "?"}s, measured ${v.measuredDowntimeSec ?? "-"}s`);
  }
  if (v.failure) out.push(`failed: ${v.failure.code}${v.failure.step ? ` at ${v.failure.step}` : ""}`);
  const na = v.nextAction;
  out.push(`waiting: ${na.kind}${na.stepKey ? ` ${na.stepKey}` : ""} ${na.code} (since ${na.since}${na.notBefore ? `, not before ${na.notBefore}` : ""})`);
  if (na.offersCommand && na.stepKey) out.push(`  command: tugra import run command ${v.id} ${na.stepKey}   (the hub picks the migrator, host-loop or inventory script this step waits for; the token inside is shown once)`);
  if (na.attest?.length && na.stepKey) out.push(`  you may attest: ${na.attest.join(", ")}   (tugra import run evidence ${v.id} ${na.stepKey} --check <id>)`);
  const ap = na.approval;
  if (na.kind === "approval" && ap && na.stepKey) {
    const typed = confirmHint(ap.confirm, { runId: v.id, serverName: v.targetServerName, sourceHost: v.sourceHost, ...(v.targetServers ? { serverNames: v.targetServers.map((s) => s.serverName) } : {}) });
    out.push(`  approval${ap.ponr ? " (POINT OF NO RETURN: refused over MCP, review it yourself before approving)" : ""}: review the step, then`);
    out.push(
      `    tugra import run approve ${v.id} ${na.stepKey} --hash ${ap.inputHash}` +
        (ap.requiredAcks.length ? ` --ack ${ap.requiredAcks.join(",")}` : "") +
        (typed ? ` --confirm ${shellQuote(typed)}` : "") +
        (ap.requiresDataRisk ? " --accept-data-risk" : ""),
    );
    if (ap.ackable.length) out.push(`    acknowledgeable checks: ${ap.ackable.join(", ")}`);
    if (ap.ttlSec) out.push(`    valid for ${Math.round(ap.ttlSec / 60)} min after you approve`);
  }
  out.push("");
  out.push(
    formatSteps(v.steps)
      .map((l) => `  ${l}`)
      .join("\n"),
  );
  return out;
}

function formatSteps(steps: RunStepView[]): string[] {
  const rows = steps.map((s) => ({
    step: s.key,
    status: s.status,
    kind: s.kind,
    attempt: String(s.attempt),
    progress: s.progress && s.progress.total > 0 ? `${s.progress.done}/${s.progress.total} ${s.progress.unit}` : "",
    rollback: s.rollbackClass,
    error: s.lastError ?? "",
  }));
  const cols: Array<[keyof (typeof rows)[number], string]> = [["step", "STEP"], ["status", "STATUS"], ["kind", "KIND"], ["attempt", "TRY"], ["progress", "PROGRESS"], ["rollback", "ROLLBACK"], ["error", "ERROR"]];
  const widths = cols.map(([k, h]) => Math.max(h.length, ...rows.map((r) => r[k].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").replace(/\s+$/, "");
  return [line(cols.map(([, h]) => h)), ...rows.map((r) => line(cols.map(([k]) => r[k])))];
}

// ───────────────────────────── campaign report (R15/R69) ─────────────────────────────

/** The most runs one campaign report reads: the hub lists at most this many per call. */
export const CAMPAIGN_REPORT_MAX_RUNS = 200;
/** Reports fetched at the same time (a campaign is a few runs to a few dozen). */
const CAMPAIGN_FETCH_PARALLEL = 4;

interface ListedRun {
  id: string;
  status: string;
  currentStep: string | null;
  mode: string;
  topology: string;
  dryRun: boolean;
  sourceHost: string | null;
  targetServerName: string | null;
  targetServerCount?: number;
  campaign: string | null;
  failure: { step: string | null; code: string } | null;
  createdAt: string;
}
interface RunReportView {
  targets?: Array<{ serverId: string; serverName: string | null }>;
  window: { estimatedSec: number | null; measuredSec: number | null };
  items: Array<{ kind: string; name: string; outcome: string; code: string | null }>;
}

export interface CampaignRunRow {
  id: string;
  status: string;
  currentStep: string | null;
  mode: string;
  dryRun: boolean;
  sourceHost: string | null;
  targets: string[];
  estimatedSec: number | null;
  measuredSec: number | null;
  /** Item counts by outcome; null when the run's report could not be read. */
  items: { moved: number; skipped: number; acked: number; failed: number; notCutOver: number } | null;
  failure: { step: string | null; code: string } | null;
  /** The items that failed or stayed on the source, with the code that says why. */
  problems: Array<{ kind: string; name: string; outcome: string; code: string | null }>;
  reportUnreadable: boolean;
  createdAt: string;
}
export interface CampaignReport {
  campaign: string;
  runs: CampaignRunRow[];
  totals: { runs: number; completed: number; live: number; failed: number; other: number; moved: number; skipped: number; acked: number; failed_items: number; notCutOver: number };
  window: { measuredTotalSec: number | null; measuredLongestSec: number | null; estimatedTotalSec: number | null };
  sourceHosts: string[];
  targetServers: string[];
  /** True when the hub's list was as long as it can be: there may be more runs than the report holds. */
  truncated: boolean;
}

/** `GET /migration-runs?campaign=<label>`: every run of the campaign (the hub lists at most 200). */
export function buildCampaignListRequest(campaign: string): Req {
  validateCampaign(campaign);
  return buildListRequest({ campaign: campaign.trim(), limit: CAMPAIGN_REPORT_MAX_RUNS });
}

/** The campaign's runs rolled up from the run list and each run's report (`null` = that report could not be read). Pure. */
export function aggregateCampaign(campaign: string, runs: readonly ListedRun[], reports: ReadonlyMap<string, RunReportView | null>): CampaignReport {
  const mine = runs.filter((r) => r.campaign === campaign).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  const rows: CampaignRunRow[] = mine.map((r) => {
    const rep = reports.get(r.id) ?? null;
    const items = rep ? { moved: 0, skipped: 0, acked: 0, failed: 0, notCutOver: 0 } : null;
    const problems: CampaignRunRow["problems"] = [];
    for (const it of rep?.items ?? []) {
      if (it.outcome === "moved") items!.moved++;
      else if (it.outcome === "skipped") items!.skipped++;
      else if (it.outcome === "acked") items!.acked++;
      else if (it.outcome === "failed") items!.failed++;
      else items!.notCutOver++;
      if ((it.outcome === "failed" || it.outcome === "not-cut-over") && problems.length < 20) problems.push({ kind: it.kind, name: it.name, outcome: it.outcome, code: it.code });
    }
    const named = (rep?.targets ?? []).map((t) => t.serverName ?? t.serverId);
    return {
      id: r.id,
      status: r.status,
      currentStep: r.currentStep,
      mode: r.mode,
      dryRun: r.dryRun,
      sourceHost: r.sourceHost,
      targets: named.length ? named : [r.targetServerName ?? "-"],
      estimatedSec: rep?.window.estimatedSec ?? null,
      measuredSec: rep?.window.measuredSec ?? null,
      items,
      failure: r.failure,
      problems,
      reportUnreadable: rep === null,
      createdAt: r.createdAt,
    };
  });
  const totals = { runs: rows.length, completed: 0, live: 0, failed: 0, other: 0, moved: 0, skipped: 0, acked: 0, failed_items: 0, notCutOver: 0 };
  for (const r of rows) {
    if (r.status === "COMPLETED") totals.completed++;
    else if (r.status === "FAILED") totals.failed++;
    else if (isTerminal(r.status)) totals.other++;
    else totals.live++;
    if (r.items) {
      totals.moved += r.items.moved;
      totals.skipped += r.items.skipped;
      totals.acked += r.items.acked;
      totals.failed_items += r.items.failed;
      totals.notCutOver += r.items.notCutOver;
    }
  }
  const measured = rows.map((r) => r.measuredSec).filter((n): n is number => n !== null);
  const estimated = rows.map((r) => r.estimatedSec).filter((n): n is number => n !== null);
  const distinct = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))].sort();
  return {
    campaign,
    runs: rows,
    totals,
    window: {
      measuredTotalSec: measured.length ? measured.reduce((a, b) => a + b, 0) : null,
      measuredLongestSec: measured.length ? Math.max(...measured) : null,
      estimatedTotalSec: estimated.length ? estimated.reduce((a, b) => a + b, 0) : null,
    },
    sourceHosts: distinct(rows.map((r) => r.sourceHost)),
    targetServers: distinct(rows.flatMap((r) => r.targets)),
    truncated: runs.length >= CAMPAIGN_REPORT_MAX_RUNS,
  };
}

/** Read a campaign through the hub: the run list of the label, then each run's report (a few at a time). A report that cannot be read leaves its run in the table, marked. */
export async function fetchCampaignReport(campaign: string, get: (path: string) => Promise<unknown>): Promise<CampaignReport> {
  const label = campaign.trim();
  const list = (await get(buildCampaignListRequest(label).path)) as ListedRun[];
  const runs = (Array.isArray(list) ? list : []).filter((r) => r.campaign === label);
  const reports = new Map<string, RunReportView | null>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= runs.length) return;
      try {
        reports.set(runs[i].id, (await get(`${base(runs[i].id)}/report`)) as RunReportView);
      } catch {
        reports.set(runs[i].id, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CAMPAIGN_FETCH_PARALLEL, runs.length) }, worker));
  return { ...aggregateCampaign(label, runs, reports), truncated: Array.isArray(list) && list.length >= CAMPAIGN_REPORT_MAX_RUNS };
}

const dur = (n: number | null): string => (n === null ? "-" : n >= 3600 ? `${Math.floor(n / 3600)} h ${Math.round((n % 3600) / 60)} min` : n >= 60 ? `${Math.round(n / 60)} min` : `${n} s`);
const itemsText = (i: CampaignRunRow["items"]): string => (i ? `${i.moved} moved, ${i.failed} failed, ${i.notCutOver} not cut over, ${i.skipped} skipped` : "report unreadable");

/** The campaign report as terminal lines: the totals, then one row per run, then what failed or stayed on the source. */
export function formatCampaignReport(r: CampaignReport): string[] {
  const t = r.totals;
  const out = [
    `campaign ${r.campaign}: ${t.runs} runs: ${t.completed} completed, ${t.live} live, ${t.failed} failed, ${t.other} dry-run or stopped`,
    `items: ${t.moved} moved, ${t.failed_items} failed, ${t.notCutOver} not cut over, ${t.skipped} skipped, ${t.acked} accepted`,
    `source hosts: ${r.sourceHosts.join(", ") || "-"}`,
    `target servers: ${r.targetServers.join(", ") || "-"}`,
    r.window.measuredTotalSec === null ? "downtime: no window measured yet" : `downtime: ${dur(r.window.measuredTotalSec)} in total, longest ${dur(r.window.measuredLongestSec)}`,
  ];
  if (r.truncated) out.push(`only the newest ${CAMPAIGN_REPORT_MAX_RUNS} runs are listed by the hub; there may be more`);
  out.push("");
  const rows = r.runs.map((x) => ({
    id: x.id,
    status: x.status,
    step: x.currentStep ?? "",
    source: x.sourceHost ?? "-",
    targets: x.targets.join(","),
    window: `${dur(x.estimatedSec)} / ${dur(x.measuredSec)}`,
    items: itemsText(x.items),
    failure: x.failure ? `${x.failure.step ?? ""} ${x.failure.code}`.trim() : "",
  }));
  const cols: Array<[keyof (typeof rows)[number], string]> = [["id", "ID"], ["status", "STATUS"], ["step", "STEP"], ["source", "SOURCE"], ["targets", "TARGETS"], ["window", "WINDOW (EST / MEASURED)"], ["items", "ITEMS"], ["failure", "FAILURE"]];
  const widths = cols.map(([k, h]) => Math.max(h.length, ...rows.map((x) => x[k].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").replace(/\s+$/, "");
  out.push(line(cols.map(([, h]) => h)), ...rows.map((x) => line(cols.map(([k]) => x[k]))));
  const problems = r.runs.flatMap((x) => x.problems.map((p) => `  ${x.sourceHost ?? "-"}: ${p.kind} ${p.name}: ${p.outcome}${p.code ? ` (${p.code})` : ""}`));
  if (problems.length) out.push("", "failed or not cut over:", ...problems);
  return out;
}

const mdCell = (v: string): string => v.replace(/[|\r\n]+/g, " ").trim();

/** The same report as Markdown (what `--format md` prints), cells escaped. */
export function formatCampaignMarkdown(r: CampaignReport): string {
  const t = r.totals;
  const lines = [
    `# Campaign ${mdCell(r.campaign)}`,
    "",
    `- Runs: ${t.runs} (${t.completed} completed, ${t.live} live, ${t.failed} failed, ${t.other} dry-run or stopped)`,
    `- Items: ${t.moved} moved, ${t.failed_items} failed, ${t.notCutOver} not cut over, ${t.skipped} skipped, ${t.acked} accepted`,
    `- Source hosts: ${r.sourceHosts.map(mdCell).join(", ") || "-"}`,
    `- Target servers: ${r.targetServers.map(mdCell).join(", ") || "-"}`,
    `- Downtime measured: ${r.window.measuredTotalSec === null ? "none yet" : `${dur(r.window.measuredTotalSec)} in total, longest ${dur(r.window.measuredLongestSec)}`}`,
    ...(r.truncated ? [`- Only the newest ${CAMPAIGN_REPORT_MAX_RUNS} runs are listed by the hub; there may be more`] : []),
    "",
    "| Run | Status | Step | Source | Targets | Window (est / measured) | Items | Failure |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...r.runs.map((x) => `| ${x.id} | ${x.status} | ${x.currentStep ?? ""} | ${mdCell(x.sourceHost ?? "-")} | ${mdCell(x.targets.join(", "))} | ${dur(x.estimatedSec)} / ${dur(x.measuredSec)} | ${itemsText(x.items)} | ${mdCell(x.failure ? `${x.failure.step ?? ""} ${x.failure.code}` : "")} |`),
  ];
  const problems = r.runs.flatMap((x) => x.problems.map((p) => `- ${mdCell(x.sourceHost ?? "-")}: ${p.kind} \`${mdCell(p.name)}\`: ${p.outcome}${p.code ? ` (${mdCell(p.code)})` : ""}`));
  if (problems.length) lines.push("", "## Failed or not cut over", "", ...problems);
  return lines.join("\n");
}

// ───────────────────────────── watch ─────────────────────────────

export interface WatchDeps {
  get: (path: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  write: (line: string) => void;
}
export interface WatchOpts {
  /** Poll interval in seconds. */
  interval: number;
  /** Return as soon as the run waits for a human (an operator step, an approval, a gate, a re-entered session, a pause or a failure). */
  untilWaiting?: boolean;
  /** Safety bound on polls (tests, scripts); 0 = unbounded. */
  maxPolls?: number;
}

/**
 * Follow a run: print every new event, and stop when the run is terminal or, with `untilWaiting`, when it needs a human.
 * Resolves to the last view. The event cursor (`afterSeq`) makes it safe to re-run; it never re-prints an event.
 */
export async function watchRun(runId: string, o: WatchOpts, d: WatchDeps): Promise<RunView> {
  let after = 0;
  let polls = 0;
  const drain = async (): Promise<void> => {
    for (;;) {
      const page = (await d.get(`${base(runId)}/events?afterSeq=${after}&limit=500`)) as { events: RunEventView[]; lastSeq: number; hasMore: boolean };
      for (const e of page.events) d.write(formatEvent(e));
      after = page.lastSeq;
      if (!page.hasMore) break;
    }
  };
  for (;;) {
    await drain();
    const view = (await d.get(base(runId))) as RunView;
    polls++;
    const done = isTerminal(view.status) || (o.untilWaiting && HUMAN_WAITS.includes(view.nextAction.kind)) || (o.maxPolls && polls >= o.maxPolls);
    if (done) {
      // The engine appends its last events (run.completed, run.aborted, the approval prompt) and only then flips the status, so
      // an event can land between the events fetch and the view fetch above. Drain once more so none is dropped.
      await drain();
      return view;
    }
    await d.sleep(Math.max(1, o.interval) * 1000);
  }
}

// ───────────────────────────── commander wiring ─────────────────────────────

const api = () => activeClient().client;

function readJson(path: string, flag: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`${flag}: cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${flag}: ${path} is not valid JSON`);
  }
}

const num = (v: string): number => Number(v);

/** Run one per-run action and print its result (`--json` prints the response verbatim). */
async function perform(action: RunAction, runId: string, o: RunOpts & { json?: boolean }): Promise<void> {
  const req = buildRequest(action, runId, o);
  const res = await api().requestRaw<unknown>(req.method, req.path, req.body);
  if (o.json || res === undefined) return void (res === undefined ? printLine("ok") : printJson(res));
  if (action === "report" && typeof res === "string") return void printLine(res);
  if (action === "command") return printCommand(res as CommandResult);
  if (action === "safety-hints" || action === "image-pin" || action === "worker-mark") return printSafetyHints(res as SafetyHints);
  if (action === "events") {
    const page = res as { events: RunEventView[]; lastSeq: number; hasMore: boolean };
    for (const e of page.events) printLine(formatEvent(e));
    printLine(`next: --after-seq ${page.lastSeq}${page.hasMore ? " (more events available)" : ""}`);
    return;
  }
  if (action === "report" || action === "source-session") return printJson(res);
  for (const l of formatStatus(res as RunView)) printLine(l);
}

interface CommandResult {
  command: string;
  kind?: string;
  commands?: { dryRun: string; run: string; resume: string };
  expiresAt: string;
}
interface SafetyHints {
  imagePins: Array<{ image: string; scope: string; digest: string; evidence: string }>;
  workerMarks: Array<{ itemRef: string; role: string }>;
}

/** The recorded safety facts: the digests the source runs and the apps marked as job runners or web apps. */
export function formatSafetyHints(h: SafetyHints): string[] {
  const out = ["image digests the source runs:"];
  if (h.imagePins.length === 0) out.push("  (none)");
  for (const p of h.imagePins) out.push(`  ${p.image}${p.scope ? ` @ ${p.scope}` : ""}  ${p.digest}  (${p.evidence})`);
  out.push("worker marks:");
  if (h.workerMarks.length === 0) out.push("  (none)");
  for (const m of h.workerMarks) out.push(`  ${m.itemRef}  ${m.role}`);
  return out;
}
function printSafetyHints(h: SafetyHints): void {
  for (const l of formatSafetyHints(h)) printLine(l);
}

function printCommand(r: CommandResult): void {
  if (r.kind === "host-loop") printLine(`Run this ON THE COOLIFY HOST (expires ${r.expiresAt}). It loops over the source hosts with Coolify's own SSH keys. It carries a live token and is shown ONCE; reissue with --reissue.`);
  else if (r.kind === "inventory") printLine(`Run this READ-ONLY inventory ON THE COOLIFY HOST (expires ${r.expiresAt}). It lists the containers and volumes of each source host. It carries a live token and is shown ONCE; reissue with --reissue.`);
  else printLine(`Run this ON THE SOURCE HOST (expires ${r.expiresAt}). It carries a live token and is shown ONCE; reissue with --reissue.`);
  printLine("");
  printLine(r.command);
  if (r.commands) {
    printLine("");
    printLine("# 1. inspect only (writes nothing):");
    printLine(r.commands.dryRun);
    printLine("# 2. the copy:");
    printLine(r.commands.run);
    printLine("# 3. resume after an interruption:");
    printLine(r.commands.resume);
  }
}

export function register(program: Command): void {
  const imp = program.commands.find((c) => c.name() === "import") ?? program.command("import").description("Fleet import (Coolify / Dokploy): follow-ups, object migration, cutover");
  const run = imp.command("run").description("Guided migration run: preflight, import, data, TLS, verify and cutover as one resumable, abortable flow");

  run
    .command("list")
    .description("List your migration runs")
    .option("--team <id>", "only this team")
    .option("--status <status>", "only this status, e.g. WAITING")
    .option("--active", "only live runs")
    .option("--campaign <label>", "only the runs of this campaign")
    .option("--limit <n>", "at most n rows (1-200)", num)
    .option("--json", "output as JSON")
    .action(async (o: RunOpts & { json?: boolean }) => {
      const req = buildListRequest(o);
      const rows = await api().requestRaw<Array<Record<string, unknown>>>(req.method, req.path);
      if (o.json) return printJson(rows);
      printTable(rows, [
        { key: "id", header: "ID" },
        { key: "status", header: "STATUS" },
        { key: "currentStep", header: "STEP" },
        { key: "mode", header: "MODE" },
        { key: "topology", header: "TOPOLOGY" },
        { key: "dryRun", header: "DRY" },
        { key: "nextActionKind", header: "WAITING" },
        { key: "targetServerName", header: "TARGET" },
        { key: "targetServerCount", header: "SERVERS" },
        { key: "campaign", header: "CAMPAIGN" },
        { key: "sourceVersion", header: "SOURCE" },
      ]);
    });

  run
    .command("create")
    .description("Create a run bound to a reviewed import plan. Use --dry-run first: it only projects and writes nothing outside its own rows")
    .option("--session <id>", "the import session id")
    .option("--source-kind <kind>", `${SOURCE_KINDS.join(" | ")} (default coolify)`)
    .option("--server <id>", "the target Tugra server id")
    .option("--plan-hash <hash>", "the planHash of the plan you reviewed")
    .option("--environment <id>", "target environment id")
    .option("--mode <mode>", `${MODES.join(" | ")} (default copy; takeover additionally allows an armed decommission)`)
    .option("--topology <topology>", `${TOPOLOGIES.join(" | ")} (default two-box = DNS flip; swap-proxy = same host)`)
    .option("--dry-run", "project every step, write nothing; promote it later with `start`")
    .option("--mapping-file <path>", "the import mapping document (JSON)")
    .option("--mapping-hash <hash>", "the hash the mapping resolve returned for exactly that mapping")
    .option("--acks-file <path>", "the env-blocker acknowledgements (JSON array), as for an import apply")
    .option("--service-choices-file <path>", "per-service choices (JSON), as for an import apply")
    .option("--db-data-modes-file <path>", "per-database data modes (JSON); must equal what the plan was made with")
    .option("--reconcile", "reconcile with a previous import")
    .option("--ignore-stored-mapping", "do not use the saved mapping profile")
    .option("--no-save-mapping", "do not save the mapping profile")
    .option("--ttl-policy <policy>", `${TTL_POLICIES.join(" | ")}: honour the old DNS TTL, or skip it knowingly`)
    .option("--deploy-waves <waves>", `${DEPLOY_WAVES.join(" | ")}`)
    .option("--warm-db-seed", "take a warm DB dump during the seed step")
    .option("--stop-source", "let the migrator stop the source writers itself")
    .option("--source-runner <runner>", `${SOURCE_RUNNERS.join(" | ")}: who starts the migrator on the source host (coolify-host-loop: one script on the Coolify host loops over the source hosts)`)
    .option("--map <source=target>", "multi-host placement: <source server uuid>=<Tugra server id>; repeat for each source host. Every source host must be listed once a map is given", (v: string, prev: string[] = []) => [...prev, v])
    .option("--server-map-file <path>", "multi-host placement as a JSON object {sourceServerUuid: tugraServerId}")
    .option("--campaign <label>", "group the runs of one migration campaign")
    .option("--host-loop-key-dir <path>", `host-loop: the directory of Coolify's SSH keys on the Coolify host (default ${HOST_LOOP_DEFAULT_KEY_DIR}); only the path is stored`)
    .option("--host-loop-parallel <n>", "host-loop: hosts handled at a time (1-8, default 1)", num)
    .option("--host-loop-connect-timeout <seconds>", "host-loop: SSH connect timeout (5-120, default 15)", num)
    .option("--host-loop-retries <n>", "host-loop: extra attempts per host (0-5, default 1)", num)
    .option("--deploy-concurrency <n>", "builds at a time per target server (1-8, default 1)", num)
    .option("--large-db-mode <mode>", `${LARGE_DB_MODES.join(" | ")}: what happens to a database too large for a dump artifact (default stream-logical, no size limit)`)
    .option("--service-start <mode>", `${SERVICE_START_MODES.join(" | ")}: which imported services start before the apps that need them (default dependencies)`)
    .option("--certs <mode>", `${CERT_MODES.join(" | ")}: seed the source proxy's ACME certificates`)
    .option("--accept-http01-gap", "accept hosts that only have an HTTP-01 certificate gap at cutover")
    .option("--freeze-at <time>", "schedule the freeze (ISO-8601)")
    .option("--observe-minutes <n>", "observe window after the cutover (0-4320, default 30)", num)
    .option("--manual-finalize", "finalize only after an explicit approval")
    .option("--batch-size <n>", "DNS flip: hosts per batch (1-25)", num)
    .option("--interval <seconds>", "DNS flip: pause between batches (5-600)", num)
    .option("--dns-credential <id>", "pin a team DNS credential")
    .option("--health-path <path>", "path the hub-side host checks fetch")
    .option("--row-count-mode <mode>", `${ROW_COUNT_MODES.join(" | ")}: logical-parity cost mode`)
    .option("--decommission-min-age <hours>", "takeover: minimum run age before decommission can be armed", num)
    .option("--stuck-operator-minutes <n>", "notify when a step waits for an operator longer than this", num)
    .option("--acme-email <email>", "owner input: the ACME email (blocks only TLS and cutover while unknown)")
    .option("--allow-bind", "owner input: allow bind-mount apps (default refuse)")
    .option("--no-allow-bind", "owner input: refuse bind-mount apps")
    .option("--allow-live-probe", "owner input: consent to the read-only live source probe")
    .option("--no-allow-live-probe", "owner input: no live source probe")
    .option("--source-controller <controller>", `owner input: ${SOURCE_CONTROLLERS.join(" | ")} (default manual)`)
    .option("--minio-policy <policy>", `owner input: ${MINIO_POLICIES.join(" | ")}: hosts that use the source's object storage (default hold)`)
    .option("--worker-policy <policy>", `owner input: ${WORKER_POLICIES.join(" | ")}: apps without a domain (default hold-dark)`)
    .option("--unlisted-db-policy <policy>", `owner input: ${UNLISTED_DB_POLICIES.join(" | ")}: database containers the source API does not list (default block)`)
    .option("--orphan-volume-policy <policy>", `owner input: ${ORPHAN_VOLUME_POLICIES.join(" | ")}: volumes no container uses (default block)`)
    .option("--json", "output as JSON")
    .action(async (o: RunOpts & { map?: string[]; serverMapFile?: string; mappingFile?: string; acksFile?: string; serviceChoicesFile?: string; dbDataModesFile?: string; json?: boolean }) => {
      const file = (path: string | undefined, flag: string) => (path ? readJson(path, flag) : undefined);
      const fromFile = file(o.serverMapFile, "--server-map-file");
      need(fromFile === undefined || (typeof fromFile === "object" && fromFile !== null && !Array.isArray(fromFile)), "--server-map-file must hold a JSON object {sourceServerUuid: tugraServerId}");
      const serverMap = o.map?.length || fromFile ? { ...(fromFile as Record<string, string> | undefined), ...parseServerMap(o.map ?? []) } : undefined;
      const req = buildCreateRequest({
        ...o,
        ...(serverMap ? { serverMap } : {}),
        mapping: file(o.mappingFile, "--mapping-file"),
        acks: file(o.acksFile, "--acks-file"),
        serviceChoices: file(o.serviceChoicesFile, "--service-choices-file"),
        dbDataModes: file(o.dbDataModesFile, "--db-data-modes-file"),
      });
      const view = await api().requestRaw<RunView>(req.method, req.path, req.body);
      if (o.json) return printJson(view);
      for (const l of formatStatus(view)) printLine(l);
      printLine("");
      printLine(`next: tugra import run ${o.dryRun ? "status" : "watch"} ${view.id}${o.dryRun ? "   (then `start` it to promote the dry run into a real run)" : ""}`);
    });

  const sub = (name: string, args: string, desc: string) => run.command(`${name} ${args}`).description(desc).option("--json", "output as JSON");

  sub("status", "<runId>", "Show the run: steps, what it waits for, the approval to review").action((id: string, o) => perform("status", id, o));
  sub("events", "<runId>", "Show the event log from a cursor")
    .option("--after-seq <n>", "the last seq you saw (default 0)", num)
    .option("--limit <n>", "page size (1-500)", num)
    .action((id: string, o) => perform("events", id, o));
  sub("start", "<runId>", "Start a queued run, or promote a finished dry run into a NEW real run")
    .option("--session <id>", "a fresh source session (only when the dry run's session expired)")
    .action((id: string, o) => perform("start", id, o));
  sub("approve", "<runId> <step>", "Approve a waiting step with the hash you reviewed (`status` prints the exact command)")
    .requiredOption("--hash <hash>", "the approval's inputHash from `status` (a stale hash is refused)")
    .option("--ack <ids>", "comma-separated acknowledged check ids")
    .option("--confirm <name>", "the typed confirmation `status` names (run id, target server, source host)")
    .option("--accept-data-risk", "acknowledge that stateful hosts are at stake")
    .action((id: string, step: string, o) => perform("approve", id, { ...o, step }));
  sub("retry", "<runId> <step>", "Re-enter a failed or waiting step (IMPORT: rollback + re-apply on a fresh op)").action((id: string, step: string, o) => perform("retry", id, { ...o, step }));
  sub("skip", "<runId> <step>", "Skip a skippable step (DATA_SEED)")
    .option("--reason <text>", "why (recorded)")
    .action((id: string, step: string, o) => perform("skip", id, { ...o, step }));
  sub("evidence", "<runId> <step>", "Attest a check you verified outside the hub (labelled operator-attested in the report)")
    .requiredOption("--check <id>", "the check id from the step's attest list")
    .option("--subject <s>", "what the attestation is about")
    .option("--note <text>", "a note (recorded)")
    .action((id: string, step: string, o) => perform("evidence", id, { ...o, step }));
  sub("attach", "<runId> <step>", "Attach an existing object migration to the step (credentials never pass through a run)")
    .requiredOption("--object-migration <id>", "the object migration id (`tugra objects create`)")
    .action((id: string, step: string, o) => perform("attach", id, { ...o, step }));
  sub("command", "<runId> <step>", "Mint the command of a step: the source-host migrator, the Coolify-host loop script or the host inventory (carries a live token, shown ONCE)")
    .option("--kind <kind>", `${COMMAND_KINDS.join(" | ")} (default: what the step waits for)`)
    .option("--reissue", "mint a fresh token (the previous command stops working)")
    .action((id: string, step: string, o) => perform("command", id, { ...o, step }));
  sub("inputs", "<runId>", "Answer or change owner inputs")
    .option("--acme-email <email>", "the ACME email")
    .option("--allow-bind", "allow bind-mount apps")
    .option("--no-allow-bind", "refuse bind-mount apps")
    .option("--allow-live-probe", "consent to the read-only live source probe")
    .option("--no-allow-live-probe", "no live source probe")
    .option("--source-controller <controller>", SOURCE_CONTROLLERS.join(" | "))
    .option("--minio-policy <policy>", MINIO_POLICIES.join(" | "))
    .option("--worker-policy <policy>", WORKER_POLICIES.join(" | "))
    .option("--unlisted-db-policy <policy>", UNLISTED_DB_POLICIES.join(" | "))
    .option("--orphan-volume-policy <policy>", ORPHAN_VOLUME_POLICIES.join(" | "))
    .action((id: string, o) => perform("inputs", id, o));
  sub("safety-hints", "<runId>", "Show the recorded image digests and job-runner marks").action((id: string, o) => perform("safety-hints", id, o));
  sub("image-pin", "<runId>", "Record the digest the SOURCE runs for a floating image (attested by you; the hub cannot check it), or remove it")
    .requiredOption("--image <ref>", "the image as the plan shows it, e.g. repo/app:latest")
    .option("--digest <sha256:...>", "the digest the source runs (docker image inspect on the source host)")
    .option("--scope <server>", "the source server uuid that runs it (default: every server)")
    .option("--evidence <kind>", `${PIN_EVIDENCE.join(" | ")} (default operator-attested)`)
    .option("--remove", "remove the recorded digest")
    .action((id: string, o: RunOpts & { evidence?: string; json?: boolean }) => perform("image-pin", id, { ...o, evidenceKind: o.evidence }));
  sub("worker-mark", "<runId>", "Mark an app a job runner (for an app with no domain whose role the plan cannot infer; a job-runner mark on an app that serves a domain fails preflight until removed) or a web app (starts dark); none removes the mark")
    .requiredOption("--item <itemRef>", "the plan item of the app, e.g. app:<server>:<ref>")
    .requiredOption("--role <role>", WORKER_ROLES.join(" | "))
    .action((id: string, o) => perform("worker-mark", id, o));
  sub("pause", "<runId>", "Stop forward progress (nothing is undone)").action((id: string, o) => perform("pause", id, o));
  sub("resume", "<runId>", "Resume a paused run").action((id: string, o) => perform("resume", id, o));
  sub("abort", "<runId>", "Abort BEFORE the point of no return: the source becomes authoritative again; nothing is deleted")
    .requiredOption("--confirm <runId>", "type the run id")
    .action((id: string, o) => perform("abort", id, o));
  sub("cleanup", "<runId>", "After an abort: remove the Tugra-side resources the run created (admin scope)")
    .requiredOption("--confirm <runId>", "type the run id")
    .option("--include-data", "also remove data-bearing resources (databases, volumes)")
    .option("--data-confirm <names>", "with --include-data: comma-separated exact names of the data-bearing resources")
    .action((id: string, o) => perform("cleanup", id, o));
  sub("reverse", "<runId>", "After the point of no return: lossy reverse back to the source (admin scope)")
    .requiredOption("--confirm <runId>", "type the run id")
    .option("--acknowledge-data-loss", "acknowledge that data written on Tugra after the cutover is not restored")
    .action((id: string, o) => perform("reverse", id, o));
  sub("decommission", "<runId>", "Takeover only, after finalize: STOP (never delete) the source containers (admin scope)")
    .requiredOption("--confirm <sourceHost>", "type the source instance host")
    .action((id: string, o) => perform("decommission", id, o));
  sub("source-session", "<runId>", `Re-enter the source token when the 1 h import session expired (read from $${SOURCE_TOKEN_ENV})`).action((id: string, o) => {
    const token = process.env[SOURCE_TOKEN_ENV];
    return perform("source-session", id, { ...o, token });
  });
  run
    .command("report [runId]")
    .description("The final report of one run (what moved, what did not, evidence kinds, measured window), or with --campaign the report of every run of a campaign")
    .option("--campaign <label>", "report every run of this campaign instead of one run: per run its state, hosts, window and failures, and the totals")
    .option("--format <format>", "json | md (default json for a run, a table for a campaign)")
    .option("--json", "output as JSON")
    .action(async (id: string | undefined, o: RunOpts & { json?: boolean }) => {
      need(!(id && o.campaign), "give a run id or --campaign, not both");
      if (o.campaign === undefined) {
        need(!!id, "give a run id, or --campaign <label> for the report of a whole campaign");
        return perform("report", id!, o);
      }
      oneOf(o.format, ["json", "md"], "--format");
      const rep = await fetchCampaignReport(o.campaign, (path) => api().requestRaw("GET", path));
      if (o.json || o.format === "json") return printJson(rep);
      if (o.format === "md") return void printLine(formatCampaignMarkdown(rep));
      for (const l of formatCampaignReport(rep)) printLine(l);
    });

  run
    .command("watch <runId>")
    .description("Follow a run: print new events until it finishes (or, with --until-waiting, until it needs you)")
    .option("--interval <seconds>", "poll interval (default 5)", num)
    .option("--until-waiting", "return as soon as the run waits for a human step")
    .option("--json", "print the final view as JSON")
    .action(async (id: string, o: { interval?: number; untilWaiting?: boolean; json?: boolean }) => {
      const client = api();
      const view = await watchRun(
        id,
        { interval: o.interval ?? 5, untilWaiting: o.untilWaiting },
        { get: (p) => client.requestRaw("GET", p), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), write: (l) => printLine(l) },
      );
      if (o.json) return printJson(view);
      printLine("");
      for (const l of formatStatus(view)) printLine(l);
    });
}

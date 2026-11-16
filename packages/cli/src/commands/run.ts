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

export const RUN_ACTIONS = ["status", "start", "approve", "retry", "skip", "evidence", "attach", "command", "inputs", "pause", "resume", "abort", "cleanup", "reverse", "decommission", "source-session", "report", "events"] as const;
export type RunAction = (typeof RUN_ACTIONS)[number];

export const SOURCE_KINDS = ["coolify", "dokploy"] as const;
export const MODES = ["copy", "takeover"] as const;
export const TOPOLOGIES = ["two-box", "swap-proxy"] as const;
export const TTL_POLICIES = ["wait", "skip-ack"] as const;
export const DEPLOY_WAVES = ["single", "earlyStateless"] as const;
export const CERT_MODES = ["none", "seed"] as const;
export const SOURCE_RUNNERS = ["operator", "agent"] as const;
export const SOURCE_CONTROLLERS = ["manual", "api", "agent"] as const;
export const ROW_COUNT_MODES = ["exact", "estimate"] as const;

/** Statuses after which a run never moves again by itself. */
export const TERMINAL_STATUSES: readonly string[] = ["ABORTED", "ROLLED_BACK", "REVERSED", "COMPLETED", "DRY_RUN_DONE"];
/** `nextAction.kind` values that need a human (as opposed to the hub working, a timer, or nothing left to do). */
export const HUMAN_WAITS: readonly string[] = ["operator", "approval", "session", "gate", "paused", "failed"];

export interface Req {
  method: "GET" | "POST";
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
  return { method: "GET", path: `/migration-runs${q({ teamId: o.team, status: o.status, active: o.active === undefined ? undefined : o.active, limit: o.limit })}` };
}

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
  };
  const inputs: Record<string, unknown> = {
    ...(o.acmeEmail ? { acmeEmail: o.acmeEmail } : {}),
    ...(o.allowBind !== undefined ? { allowBind: o.allowBind } : {}),
    ...(o.allowLiveProbe !== undefined ? { allowLiveShapeProbe: o.allowLiveProbe } : {}),
    ...(o.sourceController ? { sourceController: o.sourceController } : {}),
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
    },
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
      return { method: "POST", path: stepPath(runId, o.step, "command"), body: { reissue: o.reissue === true } };
    case "inputs": {
      oneOf(o.sourceController, SOURCE_CONTROLLERS, "--source-controller");
      const body = {
        ...(o.acmeEmail ? { acmeEmail: o.acmeEmail } : {}),
        ...(o.allowBind !== undefined ? { allowBind: o.allowBind } : {}),
        ...(o.allowLiveProbe !== undefined ? { allowLiveShapeProbe: o.allowLiveProbe } : {}),
        ...(o.sourceController ? { sourceController: o.sourceController } : {}),
      };
      need(Object.keys(body).length > 0, "give at least one of --acme-email, --allow-bind, --allow-live-probe, --source-controller");
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
  sourceHost: string | null;
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
export function confirmHint(confirm: string, ctx: { runId: string; serverName: string | null; sourceHost: string | null }): string | null {
  switch (confirm) {
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

/** One event as a log line: `12 2026-11-22T02:00:00Z info  FREEZE  step.freeze.started {"hosts":3}`. */
export function formatEvent(e: RunEventView): string {
  const params = e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : "";
  return `${String(e.seq).padStart(4)} ${e.at} ${e.level.padEnd(5)} ${(e.stepKey ?? "-").padEnd(13)} ${e.code}${params}`;
}

/** The human summary of a run: header, what it waits for, the approval to review (if any) and the step table. */
export function formatStatus(v: RunView): string[] {
  const out: string[] = [];
  out.push(`run ${v.id}  ${v.status}${v.dryRun ? "  (dry run)" : ""}  step ${v.currentStep ?? "-"}  ${v.mode}/${v.topology}`);
  out.push(`source ${v.sourceHost ?? "?"} -> target ${v.targetServerName ?? "?"}   point of no return: ${v.ponrAt ? `reached ${v.ponrAt}` : "not reached"}`);
  if (v.windowEstimate?.freezeToFlipSec != null || v.measuredDowntimeSec != null) {
    out.push(`downtime window: estimated ${v.windowEstimate?.freezeToFlipSec ?? "?"}s, measured ${v.measuredDowntimeSec ?? "-"}s`);
  }
  if (v.failure) out.push(`failed: ${v.failure.code}${v.failure.step ? ` at ${v.failure.step}` : ""}`);
  const na = v.nextAction;
  out.push(`waiting: ${na.kind}${na.stepKey ? ` ${na.stepKey}` : ""} ${na.code} (since ${na.since}${na.notBefore ? `, not before ${na.notBefore}` : ""})`);
  if (na.offersCommand && na.stepKey) out.push(`  source-host command: tugra import run command ${v.id} ${na.stepKey}   (the token inside is shown once)`);
  if (na.attest?.length && na.stepKey) out.push(`  you may attest: ${na.attest.join(", ")}   (tugra import run evidence ${v.id} ${na.stepKey} --check <id>)`);
  const ap = na.approval;
  if (na.kind === "approval" && ap && na.stepKey) {
    const typed = confirmHint(ap.confirm, { runId: v.id, serverName: v.targetServerName, sourceHost: v.sourceHost });
    out.push(`  approval${ap.ponr ? " (POINT OF NO RETURN: approve it yourself, an agent cannot)" : ""}: review the step, then`);
    out.push(
      `    tugra import run approve ${v.id} ${na.stepKey} --hash ${ap.inputHash}` +
        (ap.requiredAcks.length ? ` --ack ${ap.requiredAcks.join(",")}` : "") +
        (typed ? ` --confirm "${typed}"` : "") +
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
  for (;;) {
    for (;;) {
      const page = (await d.get(`${base(runId)}/events?afterSeq=${after}&limit=500`)) as { events: RunEventView[]; lastSeq: number; hasMore: boolean };
      for (const e of page.events) d.write(formatEvent(e));
      after = page.lastSeq;
      if (!page.hasMore) break;
    }
    const view = (await d.get(base(runId))) as RunView;
    polls++;
    if (isTerminal(view.status)) return view;
    if (o.untilWaiting && HUMAN_WAITS.includes(view.nextAction.kind)) return view;
    if (o.maxPolls && polls >= o.maxPolls) return view;
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
  if (action === "command") return printCommand(res as { command: string; commands?: { dryRun: string; run: string; resume: string }; expiresAt: string });
  if (action === "events") {
    const page = res as { events: RunEventView[]; lastSeq: number; hasMore: boolean };
    for (const e of page.events) printLine(formatEvent(e));
    printLine(`next: --after-seq ${page.lastSeq}${page.hasMore ? " (more events available)" : ""}`);
    return;
  }
  if (action === "report" || action === "source-session") return printJson(res);
  for (const l of formatStatus(res as RunView)) printLine(l);
}

function printCommand(r: { command: string; commands?: { dryRun: string; run: string; resume: string }; expiresAt: string }): void {
  printLine(`Run this ON THE SOURCE HOST (expires ${r.expiresAt}). It carries a live token and is shown ONCE; reissue with --reissue.`);
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
    .option("--source-runner <runner>", `${SOURCE_RUNNERS.join(" | ")}: who starts the migrator on the source host`)
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
    .option("--json", "output as JSON")
    .action(async (o: RunOpts & { mappingFile?: string; acksFile?: string; serviceChoicesFile?: string; dbDataModesFile?: string; json?: boolean }) => {
      const file = (path: string | undefined, flag: string) => (path ? readJson(path, flag) : undefined);
      const req = buildCreateRequest({
        ...o,
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
  sub("command", "<runId> <step>", "Mint the source-host migrator command (carries a live token, shown ONCE)")
    .option("--reissue", "mint a fresh token (the previous command stops working)")
    .action((id: string, step: string, o) => perform("command", id, { ...o, step }));
  sub("inputs", "<runId>", "Answer or change owner inputs")
    .option("--acme-email <email>", "the ACME email")
    .option("--allow-bind", "allow bind-mount apps")
    .option("--no-allow-bind", "refuse bind-mount apps")
    .option("--allow-live-probe", "consent to the read-only live source probe")
    .option("--no-allow-live-probe", "no live source probe")
    .option("--source-controller <controller>", SOURCE_CONTROLLERS.join(" | "))
    .action((id: string, o) => perform("inputs", id, o));
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
  sub("report", "<runId>", "The final report: what moved, what did not, evidence kinds, measured window")
    .option("--format <format>", "json | md (default json)")
    .action((id: string, o) => perform("report", id, o));

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

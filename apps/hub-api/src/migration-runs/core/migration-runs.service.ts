/**
 * The facade of the one-click migration orchestrator (P7 lane A): one method per REST route / MCP tool.
 *
 * Every method re-authorizes from the actor (creator-only ownership, team membership, `apps:config` + `databases` on the
 * run's team for anything that acts, the token scope per route) and returns the fresh secret-free view. State changes are
 * compare-and-set writes on the rows plus a `kick` of the engine; the engine, holding the run's lease, applies the
 * transitions (pause, abort, cleanup, reverse), so there is exactly one writer of the state machine.
 *
 * Errors are the usual Nest HTTP exceptions whose message is a stable machine code (`plan-changed`, `run-past-ponr`, ...).
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional, UnprocessableEntityException } from "@nestjs/common";
import { isAgentSessionBaseUrl } from "@tugra/shared";
import { scopeSatisfies, type Scope } from "../../api-tokens/scopes";
import type { ServiceChoice } from "../../importer/dto";
import type { ImportMappingDoc } from "../../importer/import-mapping";
import {
  OwnerInputsSchema,
  RunApplyInputSchema,
  RunOptionsSchema,
  RunReportSchema,
  type AbortRunInput,
  type AttachInput,
  type CleanupRunInput,
  type CreateMigrationRunInput,
  type DecommissionRunInput,
  type GateResult,
  type ListMigrationRunsQuery,
  type MigrationRunSummary,
  type MigrationRunView,
  type OwnerInputs,
  type RunOptions,
  type ReverseRunInput,
  type RunCommandInput,
  type RunApplyInput,
  type RunCommandResult,
  type RunEventsPage,
  type RunEventsQuery,
  type RunReport,
  type SetRunInputsInput,
  type SourceSessionInput,
  type SourceSessionResult,
  type StartRunInput,
  type StepApprovalRecord,
  type StepApproveInput,
  type StepEvidence,
  type StepEvidenceInput,
  type StepRetryInput,
  type StepSkipInput,
  type WaitSpec,
} from "./dto";
import {
  EMPTY_STEP_EVIDENCE,
  PONR_APPROVAL_TTL_SEC,
  STEP_HANDLERS,
  SOURCE_VERSION_RE,
  STEP_MANIFEST,
  activeKeyFor,
  classifySourceVersion,
  confirmServerNames,
  lockServerIdsFor,
  stepKeysForMode,
  targetServerIdsOf,
  type MigrationRunsFacade,
  type RunActor,
  type RunMode,
  type RunStatus,
  type StepHandlerRegistry,
  type StepKey,
  type StepStatus,
} from "./run-contract";
import { CLEANUP_REQUEST_KEY, RunEngineService, type CleanupRequest } from "./run-engine.service";
import { ATTACH_STEPS, COMMAND_STEPS, OPEN_STATUSES, approvalExpiry, deriveStepAllowed, hashOf, isTerminal, isWaitingStep, serverMapOf, stripSince } from "./run-logic";
import { checkSwapPlacement } from "./swap-placement";
import { RUN_ENV, RUN_IMPORT, RUN_SINK, RUN_STORE, type RunEnvPort, type RunImportPort, type RunSessionInfo, type RunSinkPort } from "./run-ports";
import { RUN_HINTS, type RunHint, type RunHintStore } from "../steps/import/baseline/run-hints";
import { servicePinKey } from "../steps/import/baseline/image-pins";
import { openWarnings } from "./dry-run-warnings";
import { INVENTORY_ATTEST } from "../steps/data/inventory/cross-check";
import { TICK_GAP_CHECK, TICK_GAP_GATE_CHECK, tickGapNote } from "../steps/data/tick-gap";
import { HOST_REPORT_PORT, HostCommandError, RUN_HOST_COMMANDS, type HostReportPort, type RunHostCommandPort } from "../steps/data/inventory/inventory-contract";
import { ServerHasLiveRunError, type EventRow, type RunRow, type RunStore, type StepRow } from "./run-store";
import { buildReport, reportToMarkdown, runFacts, stepFacts, toSummary, toView } from "./run-view";

const conflict = (code: string): ConflictException => new ConflictException(code);
const bad = (code: string): BadRequestException => new BadRequestException(code);
const unprocessable = (code: string, extra: Record<string, unknown> = {}): UnprocessableEntityException => new UnprocessableEntityException({ statusCode: 422, message: code, code, ...extra });

@Injectable()
export class MigrationRunsService implements MigrationRunsFacade {
  constructor(
    @Inject(RUN_STORE) private readonly store: RunStore,
    private readonly engine: RunEngineService,
    @Inject(STEP_HANDLERS) private readonly registry: StepHandlerRegistry,
    @Inject(RUN_ENV) private readonly env: RunEnvPort,
    @Inject(RUN_SINK) private readonly sink: RunSinkPort,
    @Inject(RUN_IMPORT) private readonly imp: RunImportPort,
    // the host-loop / inventory command builder and the stored host reports (the data steps module provides both; optional so the
    // classic single-host facade, and specs that do not need them, work without)
    @Optional() @Inject(RUN_HOST_COMMANDS) private readonly hostCommands?: RunHostCommandPort,
    @Optional() @Inject(HOST_REPORT_PORT) private readonly hostReports?: HostReportPort,
    // the run hints (accepted warnings, pins): a finished dry run is promoted only with its warnings settled
    @Optional() @Inject(RUN_HINTS) private readonly hints?: RunHintStore,
  ) {
    this.engine.terminalHook = (runId) => this.persistReport(runId);
  }

  // ───────────────────────────── guards ─────────────────────────────

  private scope(actor: RunActor, ...needed: Scope[]): void {
    for (const s of needed) if (!scopeSatisfies(actor.scopes, s)) throw new ForbiddenException("insufficient-scope");
  }

  /** The actor's own run, or a 404 (a foreign / unknown run is indistinguishable). */
  private async load(actor: RunActor, id: string): Promise<RunRow> {
    const run = await this.store.get(id);
    if (!run || run.actorId !== actor.userId) throw new NotFoundException("run-not-found");
    const st = await this.env.standing(actor.userId, run.teamId);
    if (!st.member) throw new NotFoundException("run-not-found");
    return run;
  }

  /** Like {@link load} plus the permissions every acting call needs on the run's team. */
  private async loadActing(actor: RunActor, id: string): Promise<RunRow> {
    const run = await this.load(actor, id);
    const st = await this.env.standing(actor.userId, run.teamId);
    if (!st.appsConfig || !st.databases) throw new ForbiddenException("insufficient-permission");
    return run;
  }

  private async view(run: RunRow): Promise<MigrationRunView> {
    const fresh = (await this.store.get(run.id)) ?? run;
    const [steps, names] = await Promise.all([this.store.steps(run.id), this.env.servers(this.targetIds(fresh))]);
    return toView(fresh, steps, names.get(fresh.targetServerId) ?? null, names);
  }

  /** Every target server id of a row (default first). */
  private targetIds(run: RunRow): string[] {
    return targetServerIdsOf({ targetServerId: run.targetServerId, serverMap: serverMapOf(run.serverMap) });
  }

  private async audit(actor: RunActor, action: string, runId: string, meta: Record<string, unknown> = {}): Promise<void> {
    await this.sink.audit({ actor: actor.userId, action: `migration.run.${action}`, target: runId, meta: { channel: actor.channel, ...meta } }).catch(() => undefined);
  }

  private async event(runId: string, actor: RunActor | null, code: string, level: "info" | "warn" | "error", stepKey: StepKey | null, params: Record<string, unknown> | null = null): Promise<void> {
    await this.store.appendEvent(runId, { stepKey, level, code, params, actorId: actor?.userId ?? null });
  }

  private requireOpen(run: RunRow): void {
    if (!OPEN_STATUSES.includes(run.status as RunStatus)) throw conflict("run-not-open");
  }

  private stepOf(rows: readonly StepRow[], key: StepKey): StepRow {
    const row = rows.find((r) => r.key === key);
    if (!row) throw new NotFoundException("step-not-found");
    return row;
  }

  // ───────────────────────────── create / start ─────────────────────────────

  async create(actor: RunActor, body: CreateMigrationRunInput): Promise<MigrationRunView> {
    this.scope(actor, "deploy", "read:secrets");
    const server = await this.env.server(body.targetServerId);
    if (!server) throw new NotFoundException("server-not-found");
    const st = await this.env.standing(actor.userId, server.teamId);
    if (!st.member) throw new NotFoundException("server-not-found");
    if (!st.appsConfig || !st.databases) throw new ForbiddenException("insufficient-permission");
    const serverMap = serverMapOf(body.serverMap ?? {});
    this.assertTopology(body.topology, body.sourceKind, [server.id, ...Object.values(serverMap)]);
    const session = await this.requireSession(actor, body.sessionId, body.sourceKind);
    await this.assertTargetsInTeam(server.teamId, serverMap);
    await this.assertTargetsReady([server.id, ...Object.values(serverMap)]);
    if (body.topology === "swap-proxy") await this.assertSwapPlacement(actor, body, server.id, serverMap);

    const base = RunApplyInputSchema.parse(pickApply(body));
    await this.assertPlanFresh(actor, session, base);
    const scoped = body.scope ? await this.scopedApply(actor, session, body, base, serverMap) : null;
    const applyInput = scoped?.applyInput ?? base;
    if (!body.dryRun) await this.assertSourceAgents(actor, session, applyInput);
    const sourceVersion = await this.captureSourceVersion(actor, session);

    const run = await this.insert(actor, {
      teamId: server.teamId,
      sourceKind: body.sourceKind,
      sourceHost: session.host,
      sourceVersion,
      sessionId: session.id,
      targetServerId: server.id,
      serverMap,
      campaign: body.campaign ?? null,
      planHash: body.planHash,
      mode: body.mode,
      topology: body.topology,
      dryRun: body.dryRun,
      promotedFromId: null,
      applyInput,
      options: RunOptionsSchema.parse(body.options),
      inputs: stampInputs(body.inputs, actor.userId, this.engine.clock.now()),
    });
    const scopeParams = scoped ? { scoped: true, kept: scoped.kept, excluded: scoped.excluded } : {};
    await this.event(run.id, actor, "run.created", "info", null, { dryRun: run.dryRun, mode: run.mode, topology: run.topology, targets: this.targetIds(run).length, ...scopeParams });
    await this.sourceVersionEvent(run, actor);
    await this.audit(actor, "create", run.id, { dryRun: run.dryRun, mode: run.mode, topology: run.topology, serverId: server.id, serverIds: this.targetIds(run), planHash: body.planHash, ...(run.campaign ? { campaign: run.campaign } : {}), ...scopeParams });
    if (run.dryRun) this.engine.kick(run.id, "enter");
    return this.view(run);
  }

  /**
   * Turn the create body's `scope` into the frozen apply input of a narrowed run: the importer's own exclusions (`include: false` rows
   * of a mapping document, skipped service stacks) bound by the mapping hash the later steps re-check. The importer port resolves it
   * against the live plan, so a server, project or item the plan does not have is a 400 and a scope that keeps nothing is a 400.
   */
  private async scopedApply(actor: RunActor, session: RunSessionInfo, body: CreateMigrationRunInput, base: RunApplyInput, serverMap: Record<string, string>): Promise<{ applyInput: RunApplyInput; kept: number; excluded: number }> {
    if (!this.imp.scopeApply || !body.scope) throw bad("scope-unsupported");
    const r = await this.imp.scopeApply(actor.userId, {
      sessionId: session.id,
      sourceKind: body.sourceKind,
      planHash: body.planHash,
      targetServerId: body.targetServerId,
      ...(base.environmentId ? { environmentId: base.environmentId } : {}),
      ...(base.reconcile !== undefined ? { reconcile: base.reconcile } : {}),
      ...(base.dbDataModes ? { dbDataModes: base.dbDataModes } : {}),
      ...(base.acks ? { acks: base.acks } : {}),
      ...(Object.keys(serverMap).length ? { serverMap } : {}),
      ...(base.serviceChoices ? { serviceChoices: base.serviceChoices } : {}),
      scope: body.scope,
    });
    if (!r.ok) throw bad(r.code);
    if (r.serviceChoices && Object.keys(r.serviceChoices).length > MAX_SERVICE_CHOICES) throw bad("too-many-service-choices");
    return {
      applyInput: RunApplyInputSchema.parse({ ...base, mapping: r.mapping, mappingHash: r.mappingHash, ...(r.serviceChoices ? { serviceChoices: r.serviceChoices } : {}) }),
      kept: r.kept,
      excluded: r.excluded,
    };
  }

  /**
   * Every mapped target server must exist and belong to the run's team (the standing checked for the default server covers
   * the team). A foreign or unknown server is indistinguishable: 404 `server-not-found`.
   */
  private async assertTargetsInTeam(teamId: string, serverMap: Record<string, string>): Promise<void> {
    for (const id of new Set(Object.values(serverMap))) {
      const s = await this.env.server(id);
      if (!s || s.teamId !== teamId) throw new NotFoundException("server-not-found");
    }
  }

  /**
   * Every target must be able to take apps now: its agent ONLINE and the `deploy` capability granted. A run onto a server that is
   * offline, still waiting for its agent or without the grant could only fail later, so it is refused up front with a code the
   * wizard can name (422 `target-offline`, `target-agent-pending`, `target-capability`). Databases and backups are PREFLIGHT's gates.
   */
  private async assertTargetsReady(ids: readonly string[]): Promise<void> {
    for (const id of new Set(ids)) {
      const s = await this.env.server(id);
      if (!s) continue; // existence is the team check's job
      if (s.status === "PENDING") throw unprocessable("target-agent-pending", { serverId: id });
      if (s.status !== undefined && s.status !== "ONLINE") throw unprocessable("target-offline", { serverId: id });
      if (s.capabilities !== undefined && !s.capabilities.includes("deploy")) throw unprocessable("target-capability", { serverId: id, capability: "deploy" });
    }
  }

  /**
   * A move needs an agent at both ends (the target side is `assertTargetsReady`). A real run is refused while a source server it would take
   * something from has no online agent, with the servers named (422 `source-agent-missing`), and while the agents cannot be verified at all
   * (422 `source-agents-unverified`). A dry run is not refused: it writes nothing, and it is where the owner sees what is missing.
   */
  private async assertSourceAgents(actor: RunActor, session: RunSessionInfo, apply: { mapping?: ImportMappingDoc }): Promise<void> {
    if (!this.imp.sourceAgentGaps) return;
    const r = await this.imp.sourceAgentGaps(actor.userId, { sessionId: session.id, sourceKind: session.sourceKind, ...(apply.mapping ? { mapping: apply.mapping } : {}) });
    if (r.unverified) throw unprocessable("source-agents-unverified");
    if (r.gaps.length > 0) throw unprocessable("source-agent-missing", { hosts: r.gaps });
  }

  /**
   * The proxy swap puts the new stack in place of the source's own proxy on ONE machine: it cannot span several targets
   * (`swap-multi-target`) and exists for Coolify's proxy only (`swap-unsupported-source`). Refused at create instead of at cutover.
   */
  private assertTopology(topology: string, sourceKind: string, ids: readonly string[]): void {
    if (topology !== "swap-proxy") return;
    if (sourceKind !== "coolify") throw unprocessable("swap-unsupported-source", { sourceKind });
    if (new Set(ids).size > 1) throw unprocessable("swap-multi-target", { servers: new Set(ids).size });
  }

  /**
   * A proxy swap needs the target to BE the machine the source server runs on, and that machine must not run the Coolify control plane
   * (`swap-target-not-source-host`, `swap-control-plane`). Judged from the plan's match verdicts before anything is created; a port that
   * cannot tell leaves it to CUTOVER's identity check. A source that cannot be read is a refusal, never a pass.
   */
  private async assertSwapPlacement(actor: RunActor, body: CreateMigrationRunInput, defaultTarget: string, serverMap: Record<string, string>): Promise<void> {
    if (!this.imp.sourceHosts) return;
    let hosts: Awaited<ReturnType<NonNullable<RunImportPort["sourceHosts"]>>>;
    try {
      hosts = await this.imp.sourceHosts(actor.userId, { sessionId: body.sessionId, sourceKind: body.sourceKind, ...(body.scope ? { scope: body.scope } : {}) });
    } catch {
      throw unprocessable("swap-placement-unreadable");
    }
    const v = checkSwapPlacement(hosts, defaultTarget, serverMap);
    if (!v.ok) throw unprocessable(v.code, { sourceServer: v.ref });
  }

  /** The source's version, when the import port can read it (best effort: a failure leaves it unknown for PREFLIGHT to fill). */
  private async captureSourceVersion(actor: RunActor, session: RunSessionInfo): Promise<string | null> {
    if (!this.imp.sourceVersion) return null;
    try {
      const v = (await this.imp.sourceVersion(actor.userId, { sessionId: session.id, sourceKind: session.sourceKind }))?.trim();
      return v && SOURCE_VERSION_RE.test(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** The `run.source-version` event: a warning when the version is outside the supported range (or unknown). */
  private async sourceVersionEvent(run: RunRow, actor: RunActor | null): Promise<void> {
    if (!run.sourceVersion) return;
    const verdict = classifySourceVersion(run.sourceKind as "coolify" | "dokploy", run.sourceVersion);
    await this.event(run.id, actor, "run.source-version", verdict === "supported" || verdict === "unchecked" ? "info" : "warn", null, { version: run.sourceVersion, verdict });
  }

  private async insert(
    actor: RunActor,
    f: {
      teamId: string;
      sourceKind: string;
      sourceHost: string | null;
      sourceVersion: string | null;
      sessionId: string | null;
      targetServerId: string;
      serverMap: Record<string, string>;
      campaign: string | null;
      planHash: string;
      mode: string;
      topology: string;
      dryRun: boolean;
      promotedFromId: string | null;
      applyInput: unknown;
      options: unknown;
      inputs: unknown;
    },
  ): Promise<RunRow> {
    const steps = stepKeysForMode(f.mode as RunMode).map((key) => ({ key, idx: STEP_MANIFEST[key].idx, kind: STEP_MANIFEST[key].kind, rollbackClass: STEP_MANIFEST[key].rollback }));
    try {
      return await this.store.create(
        { ...f, actorId: actor.userId, activeKey: f.dryRun ? null : activeKeyFor(f.targetServerId), lockServerIds: lockServerIdsFor(f, f.dryRun) },
        steps,
        f.dryRun ? "RUNNING" : "QUEUED",
      );
    } catch (e) {
      if (e instanceof ServerHasLiveRunError) throw conflict("server-has-live-run");
      throw e;
    }
  }

  private async requireSession(actor: RunActor, sessionId: string, kind: string): Promise<RunSessionInfo> {
    const s = await this.env.session(actor.userId, sessionId);
    if (!s || s.sourceKind !== kind) throw new NotFoundException("session-not-found");
    if (s.state !== "active" || s.expiresAt.getTime() <= this.engine.clock.now().getTime()) throw bad("session-expired");
    return s;
  }

  private async assertPlanFresh(actor: RunActor, session: RunSessionInfo, apply: { planHash: string; dbDataModes?: Record<string, "volume"> }): Promise<void> {
    const live = await this.imp.planHash(actor.userId, { sessionId: session.id, sourceKind: session.sourceKind, ...(apply.dbDataModes ? { dbDataModes: apply.dbDataModes } : {}) });
    if (live !== apply.planHash) throw conflict("plan-changed");
  }

  async start(actor: RunActor, id: string, body: StartRunInput): Promise<MigrationRunView> {
    this.scope(actor, "deploy");
    const run = await this.loadActing(actor, id);
    if (run.status === "DRY_RUN_DONE") return this.promote(actor, run, body);
    if (run.status !== "QUEUED" || run.dryRun) throw conflict("run-not-startable");
    this.assertHandlers(run.mode as RunMode);
    const ok = await this.store.updateRun(run.id, { statusIn: ["QUEUED"] }, { status: "RUNNING" });
    if (!ok) throw conflict("run-not-startable");
    await this.audit(actor, "start", run.id);
    this.engine.kick(run.id, "enter");
    return this.view(run);
  }

  private assertHandlers(mode: RunMode): void {
    const missing = this.registry.missing(mode);
    if (missing.length) throw new ConflictException({ statusCode: 409, message: "steps-unavailable", missing });
  }

  /** A dry-run becomes a NEW real run: frozen inputs copied, the plan hash re-validated against the live source. */
  private async promote(actor: RunActor, from: RunRow, body: StartRunInput): Promise<MigrationRunView> {
    const hints = this.hints ? await this.hints.list(from.id) : [];
    // the decision screen's rule, kept on the hub: a warning is accepted or fixed before the real run starts
    const open = openWarnings(await this.store.steps(from.id), hints);
    if (open.length) throw new ConflictException({ statusCode: 409, message: "dry-run-warnings-open", warnings: open });
    const sessionId = body.sessionId ?? from.sessionId;
    if (!sessionId) throw bad("session-required");
    const session = await this.requireSession(actor, sessionId, from.sourceKind);
    const apply = withServicePins(RunApplyInputSchema.parse(from.applyInput), hints);
    await this.assertPlanFresh(actor, session, apply);
    await this.assertSourceAgents(actor, session, apply);
    this.assertHandlers(from.mode as RunMode);
    const serverMap = serverMapOf(from.serverMap);
    await this.assertTargetsInTeam(from.teamId, serverMap);
    const run = await this.insert(actor, {
      teamId: from.teamId,
      sourceKind: from.sourceKind,
      sourceHost: session.host,
      sourceVersion: (await this.captureSourceVersion(actor, session)) ?? from.sourceVersion,
      sessionId: session.id,
      targetServerId: from.targetServerId,
      serverMap,
      campaign: from.campaign,
      planHash: from.planHash,
      mode: from.mode,
      topology: from.topology,
      dryRun: false,
      promotedFromId: from.id,
      applyInput: apply,
      options: from.options,
      inputs: from.inputs,
    });
    await this.event(run.id, actor, "run.created", "info", null, { dryRun: false, mode: run.mode, topology: run.topology, targets: this.targetIds(run).length });
    await this.sourceVersionEvent(run, actor);
    await this.event(run.id, actor, "run.promoted", "info", null, { fromRunId: from.id });
    await this.store.updateRun(run.id, { statusIn: ["QUEUED"] }, { status: "RUNNING" });
    await this.audit(actor, "promote", run.id, { fromRunId: from.id });
    this.engine.kick(run.id, "enter");
    return this.view(run);
  }

  // ───────────────────────────── reads ─────────────────────────────

  async list(actor: RunActor, query: ListMigrationRunsQuery): Promise<MigrationRunSummary[]> {
    const teamIds = await this.env.teamIds(actor.userId);
    const rows = await this.store.list({
      actorId: actor.userId,
      teamIds,
      ...(query.teamId ? { teamId: query.teamId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.active === "true" ? { live: true } : {}),
      ...(query.campaign ? { campaign: query.campaign } : {}),
      limit: query.active === "false" ? 200 : query.limit,
    });
    const kept = query.active === "false" ? rows.filter((r) => !OPEN_OR_LIVE.has(r.status as RunStatus)).slice(0, query.limit) : rows;
    const [steps, names] = await Promise.all([this.store.stepsOf(kept.map((r) => r.id)), this.env.servers([...new Set(kept.map((r) => r.targetServerId))])]);
    return kept.map((r) =>
      toSummary(
        r,
        steps.filter((s) => s.runId === r.id),
        names.get(r.targetServerId) ?? null,
      ),
    );
  }

  async get(actor: RunActor, id: string): Promise<MigrationRunView> {
    return this.view(await this.load(actor, id));
  }

  async events(actor: RunActor, id: string, query: RunEventsQuery): Promise<RunEventsPage> {
    const run = await this.load(actor, id);
    const rows = await this.store.events(run.id, query.afterSeq, query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      events: page.map(eventView),
      lastSeq: page.length ? page[page.length - 1].seq : query.afterSeq,
      hasMore: rows.length > query.limit,
    };
  }

  // ───────────────────────────── step actions ─────────────────────────────

  async approve(actor: RunActor, id: string, key: StepKey, body: StepApproveInput): Promise<MigrationRunView> {
    this.scope(actor, "deploy");
    const run = await this.loadActing(actor, id);
    this.requireOpen(run);
    const rows = await this.store.steps(run.id);
    const step = this.stepOf(rows, key);
    if (step.status !== "WAITING_APPROVAL") throw conflict("step-not-waiting-approval");

    const stored = (step.wait as WaitSpec | null) ? (stripSince(step.wait as object) as WaitSpec) : null;
    if (actor.channel === "mcp" && stored?.kind === "approval" && stored.binding.ponr) throw new ForbiddenException("human-confirmation-required");
    let binding;
    try {
      binding = await this.engine.bindingFor(run.id, key);
    } catch {
      throw conflict("approval-unavailable");
    }
    if (!binding) throw conflict("approval-unavailable");
    if (actor.channel === "mcp" && binding.ponr) throw new ForbiddenException("human-confirmation-required");
    if (body.boundHash !== binding.inputHash) throw conflict("approval-stale");
    if (body.acks.some((a) => !binding.ackable.includes(a))) throw bad("ack-not-allowed");
    if (binding.requiredAcks.some((a) => !body.acks.includes(a))) throw bad("acks-required");
    if (binding.requiresDataRisk && body.acceptDataRisk !== true) throw bad("data-risk-required");
    const names = await this.env.servers(this.targetIds(run));
    // every target server's name: a typed confirmation of a multi-host run must name ALL of them
    const serverNames = this.targetIds(run).map((id) => names.get(id) ?? "");
    if (!confirmMatches(binding.confirm, body.confirmName, { runId: run.id, serverName: names.get(run.targetServerId) ?? null, serverNames, sourceHost: run.sourceHost })) throw bad("bad-confirmation");

    const now = this.engine.clock.now();
    const ttlSec = binding.ponr ? Math.min(binding.ttlSec ?? PONR_APPROVAL_TTL_SEC, PONR_APPROVAL_TTL_SEC) : binding.ttlSec;
    const record: StepApprovalRecord = {
      byUserId: actor.userId,
      at: now.toISOString(),
      boundHash: binding.inputHash,
      acks: [...body.acks],
      confirmedName: body.confirmName ?? null,
      acceptDataRisk: body.acceptDataRisk === true,
      expiresAt: approvalExpiry({ ...binding, ttlSec }, now),
    };
    const ok = await this.store.updateStepIf(run.id, key, ["WAITING_APPROVAL"], { approval: record, inputHash: binding.inputHash });
    if (!ok) throw conflict("step-not-waiting-approval");
    await this.event(run.id, actor, "approval.accepted", "info", key, { ponr: binding.ponr, acks: record.acks });
    await this.audit(actor, "approve", run.id, { step: key, ponr: binding.ponr, acks: record.acks, confirmedName: record.confirmedName, acceptDataRisk: record.acceptDataRisk });
    this.engine.kick(run.id, "approve");
    return this.view(run);
  }

  async retry(actor: RunActor, id: string, key: StepKey, _body: StepRetryInput): Promise<MigrationRunView> {
    void _body;
    this.scope(actor, "deploy");
    const run = await this.loadActing(actor, id);
    const rows = await this.store.steps(run.id);
    const step = this.stepOf(rows, key);
    const manual = STEP_MANIFEST[key].manual === true && run.status === "COMPLETED";
    if (!manual) this.requireOpen(run);
    if (run.dryRun) throw conflict("run-is-dry-run");
    const allowed = deriveStepAllowed(runFacts(run), stepFacts(step));
    if (manual) {
      if (step.status !== "FAILED") throw conflict("step-not-retryable");
    } else if (!allowed.retry) throw conflict("step-not-retryable");

    if (step.status === "FAILED") {
      if (!manual && !(run.status === "FAILED" && run.failureStep === key)) throw conflict("step-not-retryable");
      const reset = await this.store.updateStepIf(run.id, key, ["FAILED"], { status: "RUNNING", lastError: null, gate: null, wait: null, notBefore: null, finishedAt: null });
      if (!reset) throw conflict("step-not-retryable");
      if (!manual) {
        const moved = await this.store.updateRun(run.id, { statusIn: ["FAILED"] }, { status: "RUNNING", failureStep: null, failureCode: null });
        if (!moved) throw conflict("run-not-open");
      }
    }
    await this.event(run.id, actor, "step.retry", "info", key);
    await this.audit(actor, "retry", run.id, { step: key });
    if (manual) void this.engine.driveManual(run.id, key, "retry");
    else this.engine.kick(run.id, "retry");
    return this.view(run);
  }

  async skip(actor: RunActor, id: string, key: StepKey, body: StepSkipInput): Promise<MigrationRunView> {
    this.scope(actor, "deploy");
    const run = await this.loadActing(actor, id);
    if (STEP_MANIFEST[key].skippable !== true) throw bad("step-not-skippable");
    if (run.dryRun) throw conflict("run-is-dry-run");
    if (!["RUNNING", "WAITING", "PAUSED", "FAILED"].includes(run.status)) throw conflict("run-not-open");
    const rows = await this.store.steps(run.id);
    const step = this.stepOf(rows, key);
    const st = step.status as StepStatus;
    if (!(st === "PENDING" || isWaitingStep(st) || st === "FAILED")) throw conflict("step-not-skippable");

    await this.engine.exclusive(run.id, ["RUNNING", "WAITING", "PAUSED", "FAILED"], async () => {
      if (st !== "PENDING") {
        // the step has started: undo what the rehearsal did before it is skipped
        const r = await this.engine.compensateOne(run.id, key, "abort");
        if (r.outcome === "failed") throw conflict("compensation-failed");
      }
      const done = await this.store.updateStepIf(run.id, key, ["PENDING", "WAITING_OPERATOR", "WAITING_APPROVAL", "WAITING_TIMER", "FAILED", "RUNNING"], {
        status: "SKIPPED",
        lastError: "step.skipped-by-operator",
        finishedAt: this.engine.clock.now(),
        wait: null,
        notBefore: null,
      });
      if (!done) throw conflict("step-not-skippable");
      if (run.status === "FAILED" && run.failureStep === key) await this.store.updateRun(run.id, { statusIn: ["FAILED"] }, { status: "RUNNING", failureStep: null, failureCode: null });
    });
    await this.event(run.id, actor, "step.skipped", "info", key, { reason: "operator" });
    await this.audit(actor, "skip", run.id, { step: key, reason: body.reason ?? null });
    this.engine.kick(run.id, "tick");
    return this.view(run);
  }

  async evidence(actor: RunActor, id: string, key: StepKey, body: StepEvidenceInput): Promise<MigrationRunView> {
    this.scope(actor, "deploy");
    const run = await this.loadActing(actor, id);
    this.requireOpen(run);
    const rows = await this.store.steps(run.id);
    const step = this.stepOf(rows, key);
    const wait = step.wait ? (stripSince(step.wait as object) as WaitSpec) : null;
    if (step.status !== "WAITING_OPERATOR" || !wait || wait.kind !== "operator" || !wait.attest?.includes(body.checkId)) throw bad("attest-not-allowed");
    if ((Object.values(INVENTORY_ATTEST) as string[]).includes(body.checkId)) {
      // an inventory attestation settles ONE finding: its subject must be a blocking finding of the stored gate, or it would be accepted and settle nothing
      const checks = (step.gate as GateResult | null)?.checks ?? [];
      if (!body.subject || !checks.some((c) => c.subject === body.subject && c.attestable?.includes(body.checkId))) throw bad("attest-subject-invalid");
      if (body.checkId === INVENTORY_ATTEST.mapped && !body.note) throw bad("attest-note-required"); // names the plan item the container IS
    }
    // N2: a write-gap attestation is about the gap the gate showed: the hub records that gap with it, so a later, longer estimate voids it
    let note = body.note;
    if (body.checkId === TICK_GAP_CHECK) {
      const shown = ((step.gate as GateResult | null)?.checks ?? []).find((c) => c.id === TICK_GAP_GATE_CHECK && c.attestable?.includes(TICK_GAP_CHECK));
      if (!shown) throw bad("attest-subject-invalid");
      const gap = (shown.params as { gapMinutes?: unknown } | undefined)?.gapMinutes;
      note = tickGapNote(typeof gap === "number" ? gap : null, body.note);
    }
    const ev = (step.evidence as StepEvidence | null) ?? EMPTY_STEP_EVIDENCE;
    if (ev.attestations.length >= 200) throw conflict("evidence-full");
    const next: StepEvidence = {
      ...ev,
      attestations: [
        ...ev.attestations,
        { checkId: body.checkId, ...(body.subject ? { subject: body.subject } : {}), ...(note ? { note } : {}), byUserId: actor.userId, at: this.engine.clock.now().toISOString() },
      ],
    };
    if (!(await this.store.updateStepIf(run.id, key, ["WAITING_OPERATOR"], { evidence: next }))) throw conflict("step-not-waiting-operator");
    await this.event(run.id, actor, "step.evidence.added", "info", key, { checkId: body.checkId, ...(body.subject ? { subject: body.subject } : {}) });
    await this.audit(actor, "evidence", run.id, { step: key, checkId: body.checkId });
    this.engine.kick(run.id, "evidence");
    return this.view(run);
  }

  async attach(actor: RunActor, id: string, key: StepKey, body: AttachInput): Promise<MigrationRunView> {
    this.scope(actor, "deploy");
    const run = await this.loadActing(actor, id);
    this.requireOpen(run);
    if (!ATTACH_STEPS.includes(key)) throw bad("step-not-attachable");
    const rows = await this.store.steps(run.id);
    const step = this.stepOf(rows, key);
    const st = step.status as StepStatus;
    if (!(st === "PENDING" || st === "RUNNING" || isWaitingStep(st))) throw conflict("step-not-attachable");
    if (body.kind === "host-inventory") {
      // a stored host inventory of THIS run (the report table is owned by the host-loop / inventory lane)
      const rep = await this.hostReports?.get(run.id, body.resourceId);
      if (!rep || rep.kind !== "inventory") throw new NotFoundException("resource-not-found");
    } else {
      const res = await this.env.objectMigration(body.resourceId);
      if (!res || res.teamId !== run.teamId) throw new NotFoundException("resource-not-found");
    }
    const ev = (step.evidence as StepEvidence | null) ?? EMPTY_STEP_EVIDENCE;
    if (!ev.attachments.some((a) => a.kind === body.kind && a.resourceId === body.resourceId)) {
      if (ev.attachments.length >= 50) throw conflict("evidence-full");
      const next: StepEvidence = { ...ev, attachments: [...ev.attachments, { kind: body.kind, resourceId: body.resourceId, byUserId: actor.userId, at: this.engine.clock.now().toISOString() }] };
      if (!(await this.store.updateStepIf(run.id, key, ["PENDING", "RUNNING", "WAITING_OPERATOR", "WAITING_APPROVAL", "WAITING_TIMER"], { evidence: next }))) throw conflict("step-not-attachable");
      await this.event(run.id, actor, "step.attached", "info", key, { kind: body.kind, resourceId: body.resourceId });
      await this.audit(actor, "attach", run.id, { step: key, kind: body.kind, resourceId: body.resourceId });
    }
    this.engine.kick(run.id, "attach");
    return this.view(run);
  }

  async command(actor: RunActor, id: string, key: StepKey, body: RunCommandInput, hubBase: string): Promise<RunCommandResult> {
    this.scope(actor, "deploy", "read:secrets");
    const run = await this.loadActing(actor, id);
    if (!COMMAND_STEPS.includes(key)) throw bad("step-has-no-command");
    const opts = RunOptionsSchema.parse(run.options);
    // the rollback of a host-loop freeze must stay obtainable once the run is aborting or aborted: it needs no token and no open run
    if (key === "FREEZE" && (run.status === "ABORTING" || run.status === "ABORTED")) return this.unfreezeCommand(actor, run, opts, hubBase);
    this.requireOpen(run);
    const rows = await this.store.steps(run.id);
    const step = this.stepOf(rows, key);
    // the kind follows what the step WAITS for (a DATA_SEED that needs the host inventory waits for `inventory`, not for the migrator
    // script); an explicit kind wins, and a step that names none keeps the run's default (host-loop runs, FREEZE)
    const waited = step.wait ? (stripSince(step.wait as object) as WaitSpec) : null;
    const waitedKind = waited?.kind === "operator" ? waited.commandKind : undefined;
    const kind = body.kind ?? waitedKind ?? (opts.sourceRunner === "coolify-host-loop" || key === "FREEZE" ? "host-loop" : "migrator");
    if (key === "FREEZE" && kind !== "host-loop" && kind !== "inventory") throw bad("step-has-no-command");
    if (kind === "host-loop" && opts.sourceRunner !== "coolify-host-loop") throw conflict("command-kind-unavailable"); // the loop exists only for that runner
    if (kind !== "migrator" && !this.hostCommands) throw conflict("command-kind-unavailable");
    if (!deriveStepAllowed(runFacts(run), stepFacts(step)).command) throw conflict("step-not-waiting-command");
    if (!run.opId) throw conflict("run-has-no-op");
    const attested = ((step.evidence as StepEvidence | null) ?? EMPTY_STEP_EVIDENCE).attestations.map((a) => a.checkId);
    if (kind !== "migrator") {
      // dry-build with a placeholder token BEFORE minting: a request that cannot succeed (no hosts, an unsafe value) must not
      // rotate the live token and kill a command the operator already pasted
      await this.buildHostCommand(run, key, kind, `tugra_mig_${"x".repeat(43)}`, hubBase, attested);
    }
    const minted = await this.imp.mintCommand(actor.userId, run.opId, hubBase, { reissue: body.reissue, certs: opts.certs === "seed" });
    await this.event(run.id, actor, "step.command.issued", "info", key, { reissue: body.reissue, kind });
    await this.audit(actor, "command", run.id, { step: key, reissue: body.reissue, kind, expiresAt: minted.expiresAt.toISOString() });
    if (kind !== "migrator") {
      const token = /TUGRA_MIGRATION_TOKEN=(tugra_mig_[A-Za-z0-9_-]{43})/.exec(minted.command)?.[1];
      if (!token) throw conflict("command-kind-unavailable");
      const built = await this.buildHostCommand(run, key, kind, token, hubBase, attested);
      return { stepKey: key, kind, opId: run.opId, expiresAt: minted.expiresAt.toISOString(), command: built.command, shownOnce: true };
    }
    return { stepKey: key, kind, opId: run.opId, expiresAt: minted.expiresAt.toISOString(), command: minted.command, ...(minted.commands ? { commands: minted.commands } : {}), shownOnce: true };
  }

  /**
   * The unfreeze script of a host-loop freeze for an aborting or aborted run: the hosts come from the FREEZE step's compensation
   * record, no migration token is minted (the script talks to no hub, and the run's token is revoked by then), so it can be asked for
   * again whenever the operator needs it. `expiresAt` is now: there is nothing that expires.
   */
  private async unfreezeCommand(actor: RunActor, run: RunRow, opts: RunOptions, hubBase: string): Promise<RunCommandResult> {
    if (!this.hostCommands || opts.sourceRunner !== "coolify-host-loop") throw conflict("command-kind-unavailable");
    const step = this.stepOf(await this.store.steps(run.id), "FREEZE");
    const rec = (step.compensation as { freeze?: { controller?: unknown; hosts?: unknown } } | null)?.freeze;
    if (rec?.controller !== "host-loop") throw conflict("command-kind-unavailable"); // nothing was stopped by a host-loop freeze
    const hosts = Array.isArray(rec.hosts) ? rec.hosts.filter((h): h is string => typeof h === "string") : [];
    const built = await this.buildHostCommand(run, "FREEZE", "host-loop", null, hubBase, [], hosts);
    await this.event(run.id, actor, "step.command.issued", "info", "FREEZE", { reissue: false, kind: "host-loop", unfreeze: true });
    await this.audit(actor, "command", run.id, { step: "FREEZE", reissue: false, kind: "host-loop", unfreeze: true });
    return { stepKey: "FREEZE", kind: "host-loop", opId: run.opId ?? run.id, expiresAt: this.engine.clock.now().toISOString(), command: built.command, shownOnce: true };
  }

  /** Build a host-loop / inventory command through the data steps' builder, mapping its fixed refusals to HTTP errors. */
  private async buildHostCommand(run: RunRow, key: StepKey, kind: "host-loop" | "inventory", token: string | null, hubBase: string, attested: readonly string[], unfreezeHosts?: readonly string[]): Promise<{ command: string; hosts: string[] }> {
    try {
      return await this.hostCommands!.build({ run: this.engine.snapshot(run), step: key, kind, token, hubBase, attested, ...(unfreezeHosts ? { unfreezeHosts } : {}) });
    } catch (e) {
      if (!(e instanceof HostCommandError)) throw e;
      if (e.code === "no-hosts") throw conflict("host-loop-no-hosts");
      if (e.code === "unsafe-input") throw bad("host-loop-unsafe-input");
      if (e.code === "step-unsupported") throw bad("step-has-no-command");
      throw conflict("command-kind-unavailable");
    }
  }

  async setInputs(actor: RunActor, id: string, body: SetRunInputsInput): Promise<MigrationRunView> {
    this.scope(actor, "deploy");
    const run = await this.loadActing(actor, id);
    this.requireOpen(run);
    const current = OwnerInputsSchema.parse(run.inputs ?? {});
    const merged = { ...current, ...stampInputs(body, actor.userId, this.engine.clock.now()) } as OwnerInputs;
    const ok = await this.store.updateRun(run.id, { statusIn: OPEN_STATUSES }, { inputs: OwnerInputsSchema.parse(merged) });
    if (!ok) throw conflict("run-not-open");
    for (const k of Object.keys(body)) await this.event(run.id, actor, "run.input.set", "info", null, { key: k });
    await this.audit(actor, "inputs", run.id, { keys: Object.keys(body) });
    this.engine.kick(run.id, "tick");
    return this.view(run);
  }

  // ───────────────────────────── run actions ─────────────────────────────

  async pause(actor: RunActor, id: string): Promise<MigrationRunView> {
    this.scope(actor, "deploy");
    const run = await this.loadActing(actor, id);
    if (!(await this.store.updateRun(run.id, { statusIn: ["RUNNING", "WAITING"] }, { pauseRequested: true }))) throw conflict("run-not-pausable");
    await this.audit(actor, "pause", run.id);
    this.engine.interrupt(run.id);
    this.engine.kick(run.id, "tick");
    return this.view(run);
  }

  async resume(actor: RunActor, id: string): Promise<MigrationRunView> {
    this.scope(actor, "deploy");
    const run = await this.loadActing(actor, id);
    if (!(await this.store.updateRun(run.id, { statusIn: ["PAUSED"] }, { status: "RUNNING", pauseRequested: false }))) throw conflict("run-not-paused");
    await this.event(run.id, actor, "run.resumed", "info", null);
    await this.audit(actor, "resume", run.id);
    this.engine.kick(run.id, "tick");
    return this.view(run);
  }

  async abort(actor: RunActor, id: string, body: AbortRunInput): Promise<MigrationRunView> {
    this.scope(actor, "deploy");
    const run = await this.loadActing(actor, id);
    if (body.confirmName !== run.id) throw bad("bad-confirmation");
    if (run.ponrAt) throw conflict("run-past-ponr");
    this.requireOpen(run);
    const ok = await this.store.updateRun(run.id, { statusIn: OPEN_STATUSES, ponrUnset: true }, { status: "ABORTING", abortRequested: true, pauseRequested: false });
    if (!ok) {
      const now = await this.store.get(run.id);
      throw conflict(now?.ponrAt ? "run-past-ponr" : "run-not-open");
    }
    await this.event(run.id, actor, "run.abort.requested", "warn", null);
    await this.audit(actor, "abort", run.id);
    this.engine.interrupt(run.id);
    this.engine.kick(run.id, "tick");
    return this.view(run);
  }

  async cleanup(actor: RunActor, id: string, body: CleanupRunInput): Promise<MigrationRunView> {
    this.scope(actor, "admin");
    const run = await this.loadActing(actor, id);
    if (body.confirmName !== run.id) throw bad("bad-confirmation");
    if (run.status !== "ABORTED" || run.dryRun || (!run.opId && run.opHistory.length === 0)) throw conflict("run-not-cleanable");
    const rows = await this.store.steps(run.id);
    const importStep = this.stepOf(rows, "IMPORT");
    const request: CleanupRequest = { includeData: body.includeData, dataConfirmNames: body.includeData ? [...body.dataConfirmNames] : [] };
    await this.store.updateStep(run.id, "IMPORT", { compensation: { ...((importStep.compensation as Record<string, unknown> | null) ?? {}), [CLEANUP_REQUEST_KEY]: request } });
    let ok: boolean;
    try {
      ok = await this.store.updateRun(run.id, { statusIn: ["ABORTED"] }, { status: "ROLLING_BACK", activeKey: activeKeyFor(run.targetServerId), lockServerIds: this.targetIds(run), finishedAt: null });
    } catch (e) {
      if (e instanceof ServerHasLiveRunError) throw conflict("server-has-live-run");
      throw e;
    }
    if (!ok) throw conflict("run-not-cleanable");
    await this.event(run.id, actor, "run.cleanup.started", "warn", null, { includeData: request.includeData });
    await this.audit(actor, "cleanup", run.id, { includeData: request.includeData, dataConfirmNames: request.dataConfirmNames });
    this.engine.kick(run.id, "tick");
    return this.view(run);
  }

  async reverse(actor: RunActor, id: string, body: ReverseRunInput): Promise<MigrationRunView> {
    this.scope(actor, "admin");
    const run = await this.loadActing(actor, id);
    if (body.confirmName !== run.id) throw bad("bad-confirmation");
    if (!run.ponrAt) throw conflict("run-before-ponr");
    if (isTerminal(run.status as RunStatus) || run.status === "QUEUED") throw conflict("run-not-reversible");
    const ok = await this.store.updateRun(run.id, { statusIn: ["RUNNING", "WAITING", "PAUSED", "FAILED"], ponrUnset: false }, { status: "REVERSING", pauseRequested: false, failureStep: null, failureCode: null });
    if (!ok) throw conflict("run-not-reversible");
    await this.event(run.id, actor, "run.reverse.started", "warn", null);
    await this.audit(actor, "reverse", run.id, { acknowledgeDataLoss: true });
    this.engine.interrupt(run.id);
    this.engine.kick(run.id, "tick");
    return this.view(run);
  }

  async decommission(actor: RunActor, id: string, body: DecommissionRunInput): Promise<MigrationRunView> {
    this.scope(actor, "admin");
    if (actor.channel === "mcp") throw new ForbiddenException("human-confirmation-required");
    const run = await this.loadActing(actor, id);
    if (run.mode !== "takeover" || run.status !== "COMPLETED") throw conflict("run-not-decommissionable");
    if (!run.sourceHost || body.confirmName !== run.sourceHost) throw bad("bad-confirmation");
    const rows = await this.store.steps(run.id);
    const step = this.stepOf(rows, "DECOMMISSION");
    if (step.status !== "PENDING" && step.status !== "FAILED") throw conflict("run-not-decommissionable");
    let binding;
    try {
      binding = await this.engine.bindingFor(run.id, "DECOMMISSION");
    } catch {
      throw conflict("decommission-unavailable");
    }
    const now = this.engine.clock.now();
    const boundHash = binding?.inputHash ?? hashOf({ decommission: run.id });
    const record: StepApprovalRecord = { byUserId: actor.userId, at: now.toISOString(), boundHash, acks: [], confirmedName: body.confirmName, acceptDataRisk: false, expiresAt: binding ? approvalExpiry(binding, now) : null };
    const ok = await this.store.updateStepIf(run.id, "DECOMMISSION", ["PENDING", "FAILED"], {
      approval: record,
      inputHash: boundHash,
      ...(step.status === "FAILED" ? { status: "RUNNING" as const, lastError: null, gate: null, wait: null, finishedAt: null } : {}),
    });
    if (!ok) throw conflict("run-not-decommissionable");
    await this.event(run.id, actor, "approval.accepted", "warn", "DECOMMISSION");
    await this.audit(actor, "decommission", run.id, { confirmedName: body.confirmName });
    void this.engine.driveManual(run.id, "DECOMMISSION", "approve");
    return this.view(run);
  }

  async sourceSession(actor: RunActor, id: string, body: SourceSessionInput): Promise<SourceSessionResult> {
    this.scope(actor, "deploy", "read:secrets");
    const run = await this.loadActing(actor, id);
    this.requireOpen(run);
    if (run.dryRun) throw conflict("run-is-dry-run");
    const old = run.sessionId ? await this.env.session(actor.userId, run.sessionId) : null;
    // A session that reads through the agent has no token to renew: it is reconnected through the agent, not here.
    if (old && isAgentSessionBaseUrl(old.baseUrl)) throw conflict("source-is-agent");
    // A purged (expired) session row cannot tell us its URL any more: the run only kept the host, so fall back to https.
    const baseUrl = old?.baseUrl ?? (run.sourceHost ? `https://${run.sourceHost}` : null);
    if (!baseUrl) throw conflict("source-unknown");
    const next = await this.env.connectSession(actor.userId, {
      teamId: old?.teamId ?? run.teamId,
      sourceKind: run.sourceKind as "coolify" | "dokploy",
      baseUrl,
      token: body.token,
      ...(old?.scopeKey ? { scopeLabel: old.scopeKey } : {}),
    });
    const ok = await this.store.updateRun(run.id, { statusIn: OPEN_STATUSES }, { sessionId: next.sessionId });
    if (!ok) throw conflict("run-not-open");
    await this.event(run.id, actor, "run.session.refreshed", "info", null);
    await this.audit(actor, "source-session", run.id, { sessionId: next.sessionId });
    this.engine.kick(run.id, "tick");
    return { sessionId: next.sessionId, expiresAt: next.expiresAt.toISOString() };
  }

  // ───────────────────────────── report ─────────────────────────────

  async report(actor: RunActor, id: string): Promise<RunReport> {
    const run = await this.load(actor, id);
    return this.buildFor(run, true);
  }

  async reportMarkdown(actor: RunActor, id: string): Promise<string> {
    return reportToMarkdown(await this.report(actor, id));
  }

  private async buildFor(run: RunRow, allowStored: boolean): Promise<RunReport> {
    if (allowStored && isTerminal(run.status as RunStatus)) {
      const stored = RunReportSchema.safeParse(run.report);
      if (stored.success && stored.data.status === run.status) return stored.data;
    }
    const [steps, names, items, integrity] = await Promise.all([
      this.store.steps(run.id),
      this.env.servers(this.targetIds(run)),
      run.opId ? this.imp.opItems(run.actorId, run.opId).catch(() => []) : Promise.resolve([]),
      run.opId && this.imp.opDataIntegrity ? this.imp.opDataIntegrity(run.actorId, run.id, run.opId).catch(() => []) : Promise.resolve([]),
    ]);
    return buildReport(run, steps, items, names.get(run.targetServerId) ?? null, this.engine.clock.now(), names, integrity);
  }

  /** Persist the final report once a run settles (engine hook; best effort). */
  async persistReport(runId: string): Promise<void> {
    const run = await this.store.get(runId);
    if (!run) return;
    const report = await this.buildFor(run, false);
    await this.store.updateRun(runId, {}, { report });
  }
}

// ───────────────────────────── helpers ─────────────────────────────

const OPEN_OR_LIVE = new Set<RunStatus>(["QUEUED", "RUNNING", "WAITING", "PAUSED", "ABORTING", "ROLLING_BACK", "REVERSING", "FAILED"]);

function eventView(e: EventRow): RunEventsPage["events"][number] {
  return {
    seq: e.seq,
    at: e.at.toISOString(),
    stepKey: (e.stepKey as StepKey | null) ?? null,
    level: e.level as "info" | "warn" | "error",
    code: e.code,
    params: (e.params as RunEventsPage["events"][number]["params"]) ?? null,
    actorId: e.actorId,
  };
}

/** The most per-service choices an apply input holds (the importer's own limit). */
const MAX_SERVICE_CHOICES = 64;

/**
 * Write the pins recorded on a dry run (`service-pin` hints) into the stacks' choices, so the real run deploys the pinned version of
 * each member. A skipped stack takes none. More stacks than the importer takes choices for is a 400.
 */
export function withServicePins(apply: RunApplyInput, hints: readonly RunHint[]): RunApplyInput {
  const pins = hints.filter((h) => h.kind === "service-pin");
  if (!pins.length) return apply;
  const choices: Record<string, ServiceChoice> = { ...(apply.serviceChoices ?? {}) };
  for (const h of pins) {
    const at = h.key.lastIndexOf("#");
    const itemRef = h.key.slice(0, at);
    const member = h.key.slice(at + 1);
    if (h.key !== servicePinKey(itemRef, member) || choices[itemRef]?.skip) continue;
    // A recorded pin must take effect: the importer ignores pins when the choice disables pinning, so turn it on.
    choices[itemRef] = { ...(choices[itemRef] ?? {}), pinImages: true, pins: { ...(choices[itemRef]?.pins ?? {}), [member]: h.value } };
  }
  if (Object.keys(choices).length > MAX_SERVICE_CHOICES) throw bad("too-many-service-choices");
  return RunApplyInputSchema.parse({ ...apply, serviceChoices: choices });
}

/** The apply fields of a create body (the same names the importer's apply takes), without the undefined ones. */
function pickApply(b: CreateMigrationRunInput): Record<string, unknown> {
  const out: Record<string, unknown> = { sourceKind: b.sourceKind, targetServerId: b.targetServerId, planHash: b.planHash };
  for (const k of ["environmentId", "acks", "serviceChoices", "mapping", "mappingHash", "reconcile", "ignoreStoredMapping", "saveMapping", "dbDataModes"] as const) {
    if (b[k] !== undefined) out[k] = b[k];
  }
  return out;
}

/** Bare request values -> owner inputs with provenance. */
function stampInputs(req: Partial<Record<string, unknown>>, userId: string, at: Date): OwnerInputs {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req)) {
    if (v === undefined) continue;
    out[k] = { value: v, source: "request", setBy: userId, at: at.toISOString() };
  }
  return OwnerInputsSchema.parse(out);
}

/**
 * Does the typed name match what the binding asks for? The combined takeover form is `"<server name> <source host>"`.
 * `serverNames` are the names of EVERY target server of the run (default first): with more than one, `target-server` is read as
 * `target-servers` (fail closed: the text must name all hosts), and the typed text is {@link confirmServerNames} of them.
 */
export function confirmMatches(kind: string, typed: string | undefined, ctx: { runId: string; serverName: string | null; sourceHost: string | null; serverNames?: readonly string[] }): boolean {
  const names = ctx.serverNames && ctx.serverNames.length ? ctx.serverNames : ctx.serverName ? [ctx.serverName] : [];
  const multi = names.length > 1;
  const allNamed = names.length > 0 && names.every((n) => n.length > 0);
  const k = multi && kind === "target-server" ? "target-servers" : multi && kind === "target-server+source-host" ? "target-servers+source-host" : kind;
  switch (k) {
    case "none":
      return true;
    case "run-id":
      return typed === ctx.runId;
    case "target-server":
      return !!ctx.serverName && typed === ctx.serverName;
    case "target-servers":
      return allNamed && typed === confirmServerNames(names);
    case "source-host":
      return !!ctx.sourceHost && typed === ctx.sourceHost;
    case "target-server+source-host":
      return !!ctx.serverName && !!ctx.sourceHost && typed === `${ctx.serverName} ${ctx.sourceHost}`;
    case "target-servers+source-host":
      return allNamed && !!ctx.sourceHost && typed === `${confirmServerNames(names)} ${ctx.sourceHost}`;
    default:
      return false;
  }
}

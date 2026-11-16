/**
 * Step 1, PREFLIGHT (P7 lane A, rollback FREE): everything knowable before anything is created, as one gate.
 *
 * It re-plans the source (read-only), checks that the plan is still the one the operator reviewed, surfaces every importer
 * blocker (the ackable ones through a typed approval, the rest hard), reads the mapping and the target server's readiness
 * (agent, capabilities, ACME email, DNS credential and zone coverage, Cloudflare SSL mode) and counts what cannot move
 * automatically (bind mounts, manual data, skipped services, object stores). It writes nothing: the dry-run of the whole
 * run IS this step.
 */
import { Inject, Injectable, OnModuleInit, Optional } from "@nestjs/common";
import { validateAcmeEmail } from "../../../deploy/panel-router";
import type { ImportPlanResponse } from "../../../importer/importer.service";
import type { ResolvedMapping } from "../../../importer/import-mapping";
import type { ServicePreview } from "../../../importer/service-preview";
import type { ApprovalBinding, DryRunItem, GateCheck, GateResult, SourceBaseline } from "../../core/dto";
import {
  SOURCE_VERSION_SUPPORT,
  STEP_HANDLERS,
  RunLeaseLostError,
  classifySourceVersion,
  deployConcurrencyOf,
  makeGate,
  resolveOwnerInput,
  type ActResult,
  type CompResult,
  type Observation,
  type RunSnapshot,
  type StepContext,
  type StepHandler,
  type StepHandlerRegistry,
} from "../../core/run-contract";
import { SESSION_EXPIRED_CODE, applyAcks, hashOf } from "../../core/run-logic";
import { IMPORT_STEPS_PORT, type ImportStepsPort, type SessionState, type TargetFacts } from "./import-ports";
import { Memo, failureOf, includedItems, isPassive, itemsFromChecks, softenAckable, unackedBlockers } from "./step-utils";
import { deployWindow } from "./baseline/build-window";
import { preflightCrossCheck } from "./baseline/preflight-crosscheck";
import { emptyHostView, loadHostView, type HostView } from "../data/inventory/host-view";
import { HOST_REPORT_PORT, type HostReportPort } from "../data/inventory/inventory-contract";
import { floatingImages } from "./baseline/image-pins";
import { RUN_HINTS, type RunHint, type RunHintStore } from "./baseline/run-hints";
import { baselineItemRef, buildSourceBaseline, isDegradedAtSource, sameBaseline } from "./baseline/source-health";
import { isWorker, markConflicts, unmatchedMarks, workerMarks, workerSets } from "./baseline/workers";
import { RunAbortRequestedError } from "../../core/run-engine.service";

const MEMO_MS = 60_000;

/** The same rule the proxy applies (`validateAcmeEmail`): a syntactically valid address on a non-placeholder domain. */
function isRealAcmeEmail(v: string): boolean {
  try {
    validateAcmeEmail(v);
    return true;
  } catch {
    return false;
  }
}
const CAPS_NEEDED = ["deploy", "database"] as const;

export interface PreflightObs extends Observation {
  session: SessionState;
  plan: ImportPlanResponse | null;
  /** A stable code when the plan could not be read. */
  planError: string | null;
  target: TargetFacts | null;
  mapping: { hashChanged: boolean; orphans: number; errors: string[]; unacked: string[] } | null;
  storedMappingBlocks: boolean;
  services: ServicePreview[] | null;
  /**
   * The source's version as PREFLIGHT sees it now: the live read, else the one stored at create. `null` = unknown. Left
   * `undefined` only by callers that did not observe (the pure check list then says nothing about the version).
   */
  sourceVersion?: string | null;
  /** The source health baseline: `undefined` = the port has no such read at all (nothing to say), `unavailable` = it failed or the source has none. */
  baseline?: { state: "captured"; baseline: SourceBaseline } | { state: "unavailable" };
  /** The run's hints (image digests, job-runner marks). */
  hints?: readonly RunHint[];
  /** The stored host reports of the run (the inventory the docker-vs-API cross-check reads); absent = none were read. */
  hosts?: HostView;
}

const ev = { evidence: "hub-verified" as const };

/**
 * R4/C18: the source version against the range the run is validated for. Too old blocks (nothing is known to work there);
 * newer than the newest tested warns and the operator can accept it; a version the source did not report is a warning (the
 * hub verified it could not read one), never a pass. Dokploy has no range: no check.
 */
function sourceVersionChecks(run: RunSnapshot, obs: PreflightObs): GateCheck[] {
  if (obs.sourceVersion === undefined) return [];
  const version = obs.sourceVersion;
  const verdict = classifySourceVersion(run.sourceKind, version);
  const range = SOURCE_VERSION_SUPPORT[run.sourceKind];
  if (verdict === "unchecked" || !range) return [];
  const id = "preflight.source-version";
  if (verdict === "supported") return [{ id, status: "pass", code: "preflight.source-version-ok", params: { version: version ?? "" }, evidence: "source-api-reported" }];
  if (verdict === "newer") return [{ id, status: "fail", code: "preflight.source-version-newer", params: { version: version ?? "", tested: range.maxTested }, ackable: true, evidence: "source-api-reported" }];
  if (verdict === "too-old") return [{ id, status: "fail", code: "preflight.source-version-too-old", params: { version: version ?? "", min: range.min }, evidence: "source-api-reported" }];
  return [{ id, status: "warn", code: "preflight.source-version-unknown", params: { tested: range.maxTested }, ...ev }];
}

/** Names of up to ten items, for a check's params. */
const names = (xs: readonly string[]): string[] => xs.slice(0, 10);

/**
 * The grup-7 safety checks over the plan: the source health baseline (R28/R52), unpinned images (R11), workers that stay
 * stopped until after the cutover (R26/C13) and what the builds cost inside the downtime window (R27/C5).
 */
function safetyChecks(run: RunSnapshot, obs: PreflightObs, plan: ImportPlanResponse): GateCheck[] {
  const out: GateCheck[] = [];
  const items = includedItems(plan, run);
  const hints = obs.hints ?? [];
  const nameOf = new Map(items.map((i) => [i.itemRef, i.name]));

  // R28/R52: how the source was doing before anything changed
  if (obs.baseline?.state === "unavailable") out.push({ id: "preflight.baseline", status: "warn", code: "preflight.baseline-unavailable", ...ev });
  else if (obs.baseline?.state === "captured") {
    const entries = obs.baseline.baseline.entries;
    const degraded = entries.filter((e) => isDegradedAtSource(e) && nameOf.has(baselineItemRef(e)));
    out.push({ id: "preflight.baseline", status: "pass", code: "preflight.baseline-captured", params: { resources: entries.length, unhealthy: degraded.length }, evidence: "source-api-reported" });
    if (degraded.length) {
      out.push({ id: "preflight.source-unhealthy", status: "warn", code: "preflight.source-unhealthy", params: { count: degraded.length, items: names(degraded.map((e) => nameOf.get(baselineItemRef(e)) ?? e.ref)) }, evidence: "source-api-reported" });
    }
  }

  // R11: a floating image is whatever the registry serves today, not what the source runs
  const floating = floatingImages(items, run.applyInput, hints);
  if (floating.length) {
    const open = floating.filter((f) => !f.pinned);
    out.push(
      open.length
        ? { id: "preflight.images", status: "fail", code: "preflight.images-unpinned", params: { count: open.length, items: names(open.map((f) => (f.member ? `${f.name}/${f.member}` : f.name))) }, ackable: true, ...ev }
        : { id: "preflight.images", status: "pass", code: "preflight.images-pinned", params: { count: floating.length }, ...ev },
    );
  }

  // R26/C13: workers
  const policy = resolveOwnerInput(run.inputs, "workerPolicy") ?? "hold-dark";
  const cands = items.filter((i) => i.kind === "app").map((i) => ({ itemRef: i.itemRef, kind: i.kind, domain: domainOf(i) }));
  const marks = workerMarks(hints);
  const workers = cands.filter((cd) => isWorker(cd, run.applyInput, marks));
  if (workers.length) {
    const code = policy === "hold-dark" ? "preflight.workers-held" : policy === "exclude" ? "preflight.workers-excluded" : "preflight.workers-start-dark";
    out.push({ id: "preflight.workers", status: policy === "start-dark" ? "warn" : "pass", code, params: { count: workers.length, items: names(workers.map((w) => nameOf.get(w.itemRef) ?? w.itemRef)) }, ...ev });
  }

  // a `job-runner` mark on an app that serves a domain cannot hold it (a cutover host must run dark): refuse until the mark goes
  const conflicts = markConflicts(cands, marks);
  if (conflicts.length) {
    out.push({ id: "preflight.job-runner-domain", status: "fail", code: "preflight.job-runner-has-domain", params: { count: conflicts.length, items: names(conflicts.map((w) => nameOf.get(w.itemRef) ?? w.itemRef)) }, ...ev });
  }

  // a mark is looked up by exact item ref: one that names no app of the plan is ignored, and the real worker would start dark
  const unmatched = unmatchedMarks(items.map((i) => ({ itemRef: i.itemRef, kind: i.kind })), marks);
  if (unmatched.length) {
    out.push({ id: "preflight.worker-mark-unmatched", status: "fail", code: "preflight.worker-mark-unmatched", params: { count: unmatched.length, items: names(unmatched) }, ...ev });
  }

  // R27/C5: the builds that remain inside the downtime window
  const held = workerSets(cands, run.applyInput, marks, policy);
  const gitApps = items.filter((i) => i.kind === "app" && i.proposed.source === "GIT" && !held.held.has(i.itemRef) && !held.excluded.has(i.itemRef));
  const apps = items.filter((i) => i.kind === "app" && !held.held.has(i.itemRef) && !held.excluded.has(i.itemRef));
  if (gitApps.length) {
    const early = run.options.deployWaves === "earlyBuild";
    const w = deployWindow({ builds: early ? 0 : gitApps.length, starts: apps.length, concurrency: deployConcurrencyOf(run.options), targets: new Set([run.targetServerId, ...Object.values(run.serverMap)]).size });
    out.push({
      id: "preflight.deploy-window",
      status: early ? "pass" : "warn",
      code: early ? "preflight.deploy-window-early" : "preflight.deploy-window-inside",
      params: { builds: gitApps.length, minutes: Math.ceil(w.totalSec / 60) },
      ...ev,
    });
  }
  return out;
}

/** The primary host of an app item: `null` = none, `undefined` = the item does not say (never read as "none"). */
const domainOf = (i: { proposed: Record<string, unknown> }): string | null | undefined => (!("domain" in i.proposed) ? undefined : typeof i.proposed.domain === "string" && i.proposed.domain ? i.proposed.domain : null);

/** The pure check list (no I/O): shared by the gate, the approval binding and the dry-run projection. */
export function preflightChecks(run: RunSnapshot, obs: PreflightObs): GateCheck[] {
  const c: GateCheck[] = [];
  if (obs.session !== "active") {
    c.push({ id: "preflight.session", status: "fail", code: "preflight.session-expired", ...ev });
    return c;
  }
  if (!obs.plan) {
    c.push({ id: "preflight.plan", status: "fail", code: "preflight.plan-unavailable", ...(obs.planError ? { params: { reason: obs.planError } } : {}), ...ev });
    return c;
  }
  const plan = obs.plan;
  const items = includedItems(plan, run);
  c.push({ id: "preflight.plan-fresh", status: plan.planHash === run.planHash ? "pass" : "fail", code: plan.planHash === run.planHash ? "preflight.plan-fresh" : "preflight.plan-changed", ...ev });
  c.push({
    id: "preflight.plan",
    status: "pass",
    code: "preflight.plan-summary",
    params: { apps: items.filter((i) => i.kind === "app").length, databases: items.filter((i) => i.kind === "database").length, services: items.filter((i) => i.kind === "service").length, volumes: items.filter((i) => i.kind === "volume").length },
    ...ev,
  });

  c.push(...sourceVersionChecks(run, obs));

  // plan blockers: an ackable approval accepts "the importer skips these items"
  for (const [code, names] of unackedBlockers(plan, run)) {
    c.push({ id: `preflight.blocker.${code}`, status: "fail", code: "preflight.plan-blocker", params: { risk: code, count: names.length, items: names.slice(0, 10) }, ackable: true, ...ev });
  }

  // mapping
  if (obs.storedMappingBlocks) c.push({ id: "preflight.mapping-required", status: "fail", code: "preflight.mapping-required", ...ev });
  if (obs.mapping) {
    if (obs.mapping.hashChanged) c.push({ id: "preflight.mapping-changed", status: "fail", code: "preflight.mapping-changed", ...ev });
    if (obs.mapping.orphans > 0) c.push({ id: "preflight.mapping-orphans", status: "fail", code: "preflight.mapping-orphans", params: { count: obs.mapping.orphans }, ...ev });
    for (const code of obs.mapping.errors) c.push({ id: `preflight.mapping-conflict.${code}`, status: "fail", code: "preflight.mapping-conflict", params: { conflict: code }, ...ev });
    for (const code of obs.mapping.unacked) c.push({ id: `preflight.mapping-ack.${code}`, status: "fail", code: "preflight.mapping-unacked", params: { conflict: code }, ...ev });
  }

  // data movement the run cannot do by itself
  const pf = plan.preflight;
  const blockedDbs = pf?.databases.filter((d) => d.dataPlane === "blocked") ?? [];
  const manualDbs = pf?.databases.filter((d) => d.dataPlane === "manual") ?? [];
  if (blockedDbs.length) c.push({ id: "preflight.db-blocked", status: "warn", code: "preflight.db-blocked", params: { count: blockedDbs.length, items: blockedDbs.map((d) => d.name).slice(0, 10) }, ...ev });
  if (manualDbs.length) c.push({ id: "preflight.db-manual", status: "warn", code: "preflight.db-manual", params: { count: manualDbs.length, items: manualDbs.map((d) => d.name).slice(0, 10) }, ...ev });
  const skippedServices = pf?.services.filter((s) => s.verdict === "skipped") ?? [];
  if (skippedServices.length) c.push({ id: "preflight.services-skipped", status: "warn", code: "preflight.services-skipped", params: { count: skippedServices.length, items: skippedServices.map((s) => s.name).slice(0, 10) }, ...ev });
  const objectStores = pf?.services.filter((s) => s.objectStore) ?? [];
  if (objectStores.length) c.push({ id: "preflight.object-store", status: "warn", code: "preflight.object-store", params: { count: objectStores.length }, ...ev });
  const manualVolumes = pf?.volumes?.filter((v) => v.dataPlane === "manual" || v.dataPlane === "manual-large") ?? [];
  if (manualVolumes.length) c.push({ id: "preflight.volumes-manual", status: "warn", code: "preflight.volumes-manual", params: { count: manualVolumes.length }, ...ev });
  const binds = pf?.volumes?.filter((v) => v.type === "bind") ?? [];
  if (binds.length) {
    const allow = resolveOwnerInput(run.inputs, "allowBind");
    c.push({
      id: "preflight.bind-mounts",
      status: allow === true ? "pass" : "warn",
      code: allow === true ? "preflight.bind-mounts-allowed" : "preflight.bind-mounts-refused",
      params: { count: binds.length },
      ...(allow === true ? {} : { ownerInput: "allowBind" as const }),
      ...ev,
    });
  }
  const generated = pf?.cutover?.generatedHosts ?? [];
  if (generated.length) c.push({ id: "preflight.generated-hosts", status: "warn", code: "preflight.generated-hosts", params: { count: generated.length }, ...ev });

  c.push(...safetyChecks(run, obs, plan));
  // R2/C6: the docker-vs-API inventory cross-check, as a warning only (DATA_SEED stays the gate that blocks on it)
  c.push(...preflightCrossCheck(run, plan, obs.hosts));

  // live service probe (owner question 7)
  const hasServices = plan.items.some((i) => i.kind === "service");
  if (hasServices) {
    const consent = resolveOwnerInput(run.inputs, "allowLiveShapeProbe") === true;
    if (!consent) c.push({ id: "preflight.live-probe", status: "pass", code: "preflight.live-probe-off", ownerInput: "allowLiveShapeProbe", ...ev });
    else if (obs.services) {
      const unreadable = obs.services.filter((s) => !s.env.secretsAvailable && s.verdict !== "skipped");
      c.push(
        unreadable.length
          ? { id: "preflight.live-probe", status: "warn", code: "preflight.services-unreadable", params: { count: unreadable.length, items: unreadable.map((s) => s.name).slice(0, 10) }, ...ev }
          : { id: "preflight.live-probe", status: "pass", code: "preflight.live-probe-ok", params: { count: obs.services.length }, ...ev },
      );
    }
  }

  // target readiness
  const t = obs.target;
  if (!t) {
    c.push({ id: "preflight.target", status: "unknown", code: "preflight.target-unreadable", ...ev });
    return c;
  }
  c.push({ id: "preflight.agent", status: t.agentOnline ? "pass" : "fail", code: t.agentOnline ? "preflight.agent-online" : "preflight.agent-offline", ...ev });
  const missing = CAPS_NEEDED.filter((k) => !t.capabilities.includes(k));
  if (missing.length) c.push({ id: "preflight.capabilities", status: "fail", code: "preflight.capability-missing", params: { capabilities: [...missing] }, ...ev });
  const email = run.inputs.acmeEmail;
  const answered = !!email && email.value !== "unknown";
  // an answered address must be a REAL one (not example/test/localhost): TLS_PREISSUE and CUTOVER refuse a placeholder
  const answeredOk = answered && isRealAcmeEmail(String(email!.value));
  c.push(
    answeredOk
      ? { id: "preflight.acme-email", status: "pass", code: "preflight.acme-email-input", ...ev }
      : t.acmeEmailOk
        ? { id: "preflight.acme-email", status: "pass", code: "preflight.acme-email-ok", ...ev }
        : { id: "preflight.acme-email", status: "warn", code: answered ? "preflight.acme-email-invalid" : "preflight.acme-email-missing", ownerInput: "acmeEmail", ...ev },
  );
  if (run.topology === "two-box" && t.proxyBind !== "public") c.push({ id: "preflight.proxy-bind", status: "warn", code: "preflight.proxy-not-public", params: { bind: t.proxyBind ?? "unknown" }, ...ev });
  if (!t.dnsCredential) c.push({ id: "preflight.dns", status: "warn", code: "preflight.dns-manual", ...ev });
  else {
    const noZone = t.zones.filter((z) => !z.lookupFailed && !z.zone).map((z) => z.host);
    const failed = t.zones.filter((z) => z.lookupFailed).map((z) => z.host);
    c.push({ id: "preflight.dns", status: "pass", code: "preflight.dns-credential", params: { hosts: t.zones.length }, ...ev });
    if (noZone.length) c.push({ id: "preflight.dns-zone", status: "warn", code: "preflight.dns-zone-missing", params: { count: noZone.length, hosts: noZone.slice(0, 10) }, ...ev });
    if (failed.length) c.push({ id: "preflight.dns-lookup", status: "warn", code: "preflight.dns-lookup-failed", params: { count: failed.length, hosts: failed.slice(0, 10) }, ...ev });
    const risky = [...new Set(t.zones.filter((z) => z.sslMode === "flexible" || z.sslMode === "off").map((z) => `${z.zone}:${z.sslMode}`))];
    if (risky.length) c.push({ id: "preflight.cf-ssl-mode", status: "fail", code: "preflight.cf-ssl-mode", params: { zones: risky.slice(0, 10) }, ackable: true, ...ev });
  }
  return c;
}

@Injectable()
export class PreflightStep implements StepHandler<PreflightObs>, OnModuleInit {
  readonly key = "PREFLIGHT" as const;
  readonly kind = "auto" as const;
  readonly rollback = "FREE" as const;
  private readonly targets = new Memo<TargetFacts>(MEMO_MS);
  private readonly mappings = new Memo<ResolvedMapping | null>(MEMO_MS);
  private readonly storedMappings = new Memo<boolean>(MEMO_MS);
  private readonly probes = new Memo<ServicePreview[]>(MEMO_MS);
  private readonly versions = new Memo<string | null>(MEMO_MS);
  private readonly baselines = new Memo<SourceBaseline | null>(MEMO_MS);
  /** `runId|version` already written this process: a second observe of the same tick (or a stale snapshot) never re-emits. */
  private readonly versionWritten = new Set<string>();

  constructor(
    @Inject(STEP_HANDLERS) private readonly registry: StepHandlerRegistry,
    @Inject(IMPORT_STEPS_PORT) private readonly port: ImportStepsPort,
    @Optional() @Inject(RUN_HINTS) private readonly hintStore?: RunHintStore,
    @Optional() @Inject(HOST_REPORT_PORT) private readonly reports?: HostReportPort,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  applicable(): boolean {
    return true;
  }

  async observe(ctx: StepContext): Promise<PreflightObs> {
    const run = ctx.run;
    const userId = ctx.actor.userId;
    const bypass = !isPassive(ctx);
    const now = () => ctx.now().getTime();
    const session = await this.port.sessionState(userId, run.sessionId);
    const empty: PreflightObs = { session, plan: null, planError: null, target: null, mapping: null, storedMappingBlocks: false, services: null, sourceVersion: run.sourceVersion };
    if (session !== "active" || !run.sessionId) return empty;

    let plan: ImportPlanResponse;
    try {
      plan = await this.port.plan(userId, { sessionId: run.sessionId, sourceKind: run.sourceKind, ...(run.applyInput.dbDataModes ? { dbDataModes: run.applyInput.dbDataModes } : {}) });
    } catch (e) {
      return { ...empty, planError: failureOf(e, "preflight.plan").code };
    }
    const hosts = plan.items.filter((i) => i.kind === "app").map((i) => i.proposed.domain).filter((d): d is string => typeof d === "string" && d.length > 0);

    const target = await this.targets
      .get(`${run.id}|${run.targetServerId}`, bypass, now, () => this.port.target(userId, { serverId: run.targetServerId, ...(run.options.dnsCredentialId ? { dnsCredentialId: run.options.dnsCredentialId } : {}), hosts }))
      .catch(() => null);

    let mapping: PreflightObs["mapping"] = null;
    let storedMappingBlocks = false;
    const a = run.applyInput;
    if (a.mapping && a.mappingHash) {
      const mapping0 = a.mapping;
      const res = await this.mappings
        .get(run.id, bypass, now, () =>
          this.port.resolveMapping(userId, {
            sessionId: run.sessionId!,
            sourceKind: run.sourceKind,
            planHash: run.planHash,
            targetServerId: run.targetServerId,
            ...(a.environmentId ? { environmentId: a.environmentId } : {}),
            ...(a.reconcile !== undefined ? { reconcile: a.reconcile } : {}),
            ...(a.dbDataModes ? { dbDataModes: a.dbDataModes } : {}),
            ...(a.acks ? { acks: a.acks } : {}),
            // placement binds the mappingHash: resolve with the map IMPORT will apply with, or the two hashes never agree
            ...(Object.keys(run.serverMap ?? {}).length > 0 ? { serverMap: run.serverMap } : {}),
            mapping: mapping0,
          }),
        )
        .catch(() => null);
      if (res) {
        mapping = {
          hashChanged: res.mappingHash !== a.mappingHash,
          orphans: res.orphans.length,
          errors: [...new Set(res.conflicts.filter((x) => x.level === "error" && x.code !== "key.orphan").map((x) => x.code))].slice(0, 20),
          unacked: [...new Set(res.conflicts.filter((x) => x.requiresAck && !x.acked).map((x) => x.code))].slice(0, 20),
        };
      }
    } else if (!a.ignoreStoredMapping) {
      storedMappingBlocks = await this.storedMappings.get(run.id, bypass, now, () => this.port.storedMappingExists(userId, run.sessionId!)).catch(() => false);
    }

    let services: ServicePreview[] | null = null;
    if (plan.items.some((i) => i.kind === "service") && resolveOwnerInput(run.inputs, "allowLiveShapeProbe") === true) {
      services = await this.probes
        .get(run.id, bypass, now, () => this.port.previewServices(userId, { sessionId: run.sessionId!, sourceKind: run.sourceKind, ...(a.serviceChoices ? { choices: a.serviceChoices } : {}) }))
        .catch(() => null);
    }
    const sourceVersion = await this.sourceVersionOf(ctx, bypass);
    const baseline = await this.baselineOf(ctx, bypass);
    const hints = this.hintStore ? await this.hintStore.list(run.id, run.promotedFromId).catch(() => []) : [];
    const hostView = this.reports ? await loadHostView(this.reports, run.id).catch(() => emptyHostView()) : undefined;
    return { session, plan, planError: null, target, mapping, storedMappingBlocks, services, sourceVersion, ...(baseline ? { baseline } : {}), hints, ...(hostView ? { hosts: hostView } : {}) };
  }

  /**
   * R4: the source's version, read live (memoized; a failure falls back to the one stored at create) and written to the run when
   * it changed, with the `run.source-version` event. A read-only context (an approval lookup) refuses the write: that is fine,
   * the next real tick makes it.
   */
  private async sourceVersionOf(ctx: StepContext, bypass: boolean): Promise<string | null> {
    const run = ctx.run;
    const stored = run.sourceVersion;
    if (!this.port.sourceVersion || !run.sessionId) return stored;
    const sessionId = run.sessionId;
    const live = await this.versions
      .get(run.id, bypass, () => ctx.now().getTime(), async () => (await this.port.sourceVersion!(ctx.actor.userId, { sessionId, sourceKind: run.sourceKind }))?.trim() || null)
      .catch(() => null);
    if (!live || !/^[\x21-\x7e]{1,64}$/.test(live)) return stored;
    const mark = `${run.id}|${live}`;
    if (live !== stored && !this.versionWritten.has(mark)) {
      try {
        await ctx.patchRun({ sourceVersion: live });
        const verdict = classifySourceVersion(run.sourceKind, live);
        await ctx.emit({ level: verdict === "supported" || verdict === "unchecked" ? "info" : "warn", code: "run.source-version", params: { version: live, verdict } });
        this.versionWritten.add(mark);
      } catch (e) {
        if (e instanceof RunLeaseLostError || e instanceof RunAbortRequestedError) throw e;
      }
    }
    return live;
  }

  /** R28/R52: the source health baseline, taken while PREFLIGHT is open and written to the run (the engine ignores it once FREEZE opened). */
  private async baselineOf(ctx: StepContext, bypass: boolean): Promise<PreflightObs["baseline"] | undefined> {
    const run = ctx.run;
    if (!this.port.sourceHealth || !run.sessionId) return undefined;
    const sessionId = run.sessionId;
    const baseline = await this.baselines
      .get(run.id, bypass, () => ctx.now().getTime(), async () => {
        const rows = await this.port.sourceHealth!(ctx.actor.userId, { sessionId, sourceKind: run.sourceKind });
        return rows ? buildSourceBaseline(rows, ctx.now()) : null;
      })
      .catch(() => null);
    if (!baseline) return { state: "unavailable" };
    if (run.freezeStartedAt === null && !sameBaseline(run.sourceBaseline, baseline)) {
      try {
        await ctx.patchRun({ sourceBaseline: baseline });
      } catch (e) {
        if (e instanceof RunLeaseLostError || e instanceof RunAbortRequestedError) throw e;
      }
    }
    return { state: "captured", baseline };
  }

  async dryRun(ctx: StepContext): Promise<DryRunItem[]> {
    const obs = await this.observe(ctx);
    return itemsFromChecks(preflightChecks(ctx.run, obs));
  }

  private acks(ctx: StepContext): readonly string[] {
    return ctx.approval?.acks ?? [];
  }

  preGate(ctx: StepContext, obs: PreflightObs): GateResult {
    if (obs.session !== "active") {
      return makeGate(preflightChecks(ctx.run, obs), { wait: { kind: "operator", code: SESSION_EXPIRED_CODE } });
    }
    const checks = softenAckable(applyAcks(preflightChecks(ctx.run, obs), this.acks(ctx)));
    return makeGate(checks, { wait: { kind: "operator", code: "preflight.blocked" } });
  }

  async approvalBinding(ctx: StepContext, obs: PreflightObs): Promise<ApprovalBinding | null> {
    if (obs.session !== "active" || !obs.plan) return null;
    const open = preflightChecks(ctx.run, obs).filter((c) => c.ackable === true && c.status !== "pass");
    if (!open.length) return null;
    const ids = open.map((c) => c.id).slice(0, 200);
    return {
      inputHash: hashOf(open.map((c) => [c.id, c.status, c.params ?? null])),
      ponr: false,
      confirm: "none",
      ttlSec: null,
      requiresDataRisk: false,
      ackable: ids,
      requiredAcks: open.filter((c) => c.status === "fail" || c.status === "unknown").map((c) => c.id).slice(0, 200),
      review: { items: open.length },
    };
  }

  async act(): Promise<ActResult> {
    return { outcome: "done" }; // read-only step: the gate is the work
  }

  postGate(ctx: StepContext, obs: PreflightObs): GateResult {
    if (obs.session !== "active" || !obs.plan) return makeGate(preflightChecks(ctx.run, obs));
    return makeGate(applyAcks(preflightChecks(ctx.run, obs), this.acks(ctx)));
  }

  async compensate(): Promise<CompResult> {
    return { outcome: "nothing-to-do" };
  }
}

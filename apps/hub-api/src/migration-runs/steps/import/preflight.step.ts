/**
 * Step 1, PREFLIGHT (P7 lane A, rollback FREE): everything knowable before anything is created, as one gate.
 *
 * It re-plans the source (read-only), checks that the plan is still the one the operator reviewed, surfaces every importer
 * blocker (the ackable ones through a typed approval, the rest hard), reads the mapping and the target server's readiness
 * (agent, capabilities, ACME email, DNS credential and zone coverage, Cloudflare SSL mode) and counts what cannot move
 * automatically (bind mounts, manual data, skipped services, object stores). It writes nothing: the dry-run of the whole
 * run IS this step.
 */
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { ImportPlanResponse } from "../../../importer/importer.service";
import type { ResolvedMapping } from "../../../importer/import-mapping";
import type { ServicePreview } from "../../../importer/service-preview";
import type { ApprovalBinding, DryRunItem, GateCheck, GateResult } from "../../core/dto";
import {
  STEP_HANDLERS,
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

const MEMO_MS = 60_000;
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
}

const ev = { evidence: "hub-verified" as const };

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
  const emailAnswered = !!email && email.value !== "unknown";
  c.push(
    emailAnswered || t.acmeEmailOk
      ? { id: "preflight.acme-email", status: "pass", code: emailAnswered ? "preflight.acme-email-input" : "preflight.acme-email-ok", ...ev }
      : { id: "preflight.acme-email", status: "warn", code: "preflight.acme-email-missing", ownerInput: "acmeEmail", ...ev },
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

  constructor(
    @Inject(STEP_HANDLERS) private readonly registry: StepHandlerRegistry,
    @Inject(IMPORT_STEPS_PORT) private readonly port: ImportStepsPort,
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
    const empty: PreflightObs = { session, plan: null, planError: null, target: null, mapping: null, storedMappingBlocks: false, services: null };
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
    return { session, plan, planError: null, target, mapping, storedMappingBlocks, services };
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

/**
 * Production adapter of the import-side step port (P7 lane A): binds {@link ImportStepsPort} (and the core's
 * {@link RunImportPort}) to the existing importer, executor, apps, databases, DNS and proxy-config services. It adds no
 * business logic: every call is made AS the run's actor and re-checks permissions inside the wrapped service.
 */
import { ConflictException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { AgentWsServer } from "../../../agent-gateway/agent-ws.server";
import { ApplicationsService } from "../../../applications/applications.service";
import { DatabasesService } from "../../../databases/databases.service";
import { DnsAutomationService } from "../../../dns/dns-automation.service";
import { ProxyConfigService } from "../../../proxy-config/proxy-config.service";
import { validateAcmeEmail } from "../../../deploy/panel-router";
import { ImportExecutorService, type RollbackOptions } from "../../../importer/import-executor.service";
import { ImporterService, type ImportPlanResponse } from "../../../importer/importer.service";
import { ns, planImport } from "../../../importer/import-planner";
import { validateServiceChoices } from "../../../importer/service-choices";
import { buildServicePreview } from "../../../importer/service-preview";
import { buildPreflight } from "../../../importer/preflight";
import { buildCoverage } from "../../../importer/coverage";
import { sourceAgentGaps } from "../../../coolify-takeover/agent-coverage";
import { mapLimit } from "../../../importer/sources/map-limit";
import type { ImportApplyInput, ImportMappingResolveInput, RemoteSourceKind, ServiceChoice } from "../../../importer/dto";
import type { SourceHealthRow } from "../../../importer/import-source";
import { vxEnabled } from "../../../importer/volume-stream/vx-constants";
import { dbStreamModeRefs, dbVolumeModeRefs, isObjectStoreResult, serviceVolumeStreamable, serviceVolumesOf, volumeItemRef } from "../../../importer/volume-stream/vx-targets";
import { buildDataIntegrity } from "../data/data-integrity";
import { pinnedImageRef } from "./baseline/image-pins";
import type { ImportMappingDoc, ResolvedMapping } from "../../../importer/import-mapping";
import type { ServicePreview } from "../../../importer/service-preview";
import type { RunReport, RunScope } from "../../core/dto";
import { stable } from "../../core/run-logic";
import { applyScope, hostOfItemRef, resolveScope } from "../../core/run-scope";
import type { RunImportPort } from "../../core/run-ports";
import { diskReadingOf } from "./baseline/host-class";
import type {
  DeploymentRef,
  ImportStepsPort,
  ServiceLink,
  OpSnapshot,
  RemapApplyResult,
  RemapSummary,
  ResourceState,
  SessionState,
  TargetFacts,
} from "./import-ports";

/** How long a discovered plan is reused (a perf rate limiter for parked PREFLIGHT ticks and dry-runs; never authority). */
const PLAN_TTL_MS = 30_000;
const ZONE_HOST_CAP = 200;

const metaOf = (m: unknown): Record<string, unknown> => (typeof m === "object" && m ? (m as Record<string, unknown>) : {});

@Injectable()
export class ImportPortService implements ImportStepsPort {
  private readonly planCache = new Map<string, { at: number; plan: ImportPlanResponse }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly importer: ImporterService,
    private readonly executor: ImportExecutorService,
    private readonly apps: ApplicationsService,
    private readonly dbs: DatabasesService,
    private readonly agentWs: AgentWsServer,
    private readonly proxyConfig: ProxyConfigService,
    private readonly dns: DnsAutomationService,
  ) {}

  async sessionState(userId: string, sessionId: string | null): Promise<SessionState> {
    if (!sessionId) return "missing";
    const row = await this.prisma.importSession.findUnique({ where: { id: sessionId }, select: { actorId: true, status: true, expiresAt: true } });
    if (!row || row.actorId !== userId) return "missing";
    return row.status === "active" && row.expiresAt.getTime() > Date.now() ? "active" : "expired";
  }

  private async discoverPlan(userId: string, i: { sessionId: string; sourceKind: RemoteSourceKind; dbDataModes?: Record<string, "volume"> }): Promise<ImportPlanResponse> {
    // Mirrors ImporterService.plan WITHOUT its `lastUsedAt` touch: a dry-run must write nothing outside its own rows.
    const { source } = await this.importer.openSession(userId, i.sessionId, i.sourceKind);
    try {
      const fleet = await source.discover();
      const opts = { sourceKind: i.sourceKind, ...(i.dbDataModes && Object.keys(i.dbDataModes).length ? { dbDataModes: i.dbDataModes } : {}) };
      const coverage = buildCoverage(fleet, opts);
      return { ...planImport(fleet, opts), preflight: { ...buildPreflight(fleet, opts), ...(coverage ? { coverage } : {}) } };
    } finally {
      await source.close();
    }
  }

  async plan(userId: string, i: { sessionId: string; sourceKind: RemoteSourceKind; dbDataModes?: Record<string, "volume"> }): Promise<ImportPlanResponse> {
    const key = `${userId}|${i.sessionId}|${i.sourceKind}|${stable(i.dbDataModes ?? {})}`;
    const hit = this.planCache.get(key);
    if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.plan;
    const plan = await this.discoverPlan(userId, i);
    this.planCache.set(key, { at: Date.now(), plan });
    for (const [k, v] of this.planCache) if (Date.now() - v.at > PLAN_TTL_MS) this.planCache.delete(k);
    return plan;
  }

  async planHash(userId: string, i: { sessionId: string; sourceKind: RemoteSourceKind; dbDataModes?: Record<string, "volume"> }): Promise<string> {
    return (await this.discoverPlan(userId, i)).planHash; // never cached: the source must be re-read to bind a run to it
  }

  /** The source's own version string (`GET /version` of the source adapter), or null when it did not report one. Writes nothing. */
  async sourceVersion(userId: string, i: { sessionId: string; sourceKind: RemoteSourceKind }): Promise<string | null> {
    const { source } = await this.importer.openSession(userId, i.sessionId, i.sourceKind);
    try {
      const v = await source.verify();
      return v.ok && v.version ? v.version : null;
    } finally {
      await source.close();
    }
  }

  /**
   * The source servers a run would move and how each lines up with a Tugra server. The same plan the first step shows (its match verdicts
   * and control-plane flag), narrowed to the servers that have an item in scope. A scope the plan cannot resolve is not judged here: the
   * scope step answers it with its own code.
   */
  async sourceHosts(userId: string, i: { sessionId: string; sourceKind: RemoteSourceKind; scope?: RunScope }): Promise<Array<{ ref: string; controlPlane: boolean; tugraServerId: string | null }>> {
    if (i.sourceKind !== "coolify") return [];
    const plan = await this.importer.plan(userId, { sourceKind: "coolify", sessionId: i.sessionId });
    const resolved = i.scope ? resolveScope(plan, i.scope) : null;
    const inScope = resolved && !("fail" in resolved) ? resolved.inScope : null;
    const used = new Set<string>();
    for (const it of plan.items) if ((it.kind === "app" || it.kind === "database" || it.kind === "service") && (!inScope || inScope.has(it.itemRef))) used.add(hostOfItemRef(it.itemRef));
    return (plan.preflight?.hosts ?? []).filter((h) => used.has(h.ref)).map((h) => ({ ref: h.ref, controlPlane: h.controlPlane === true, tugraServerId: h.tugra?.serverId ?? null }));
  }

  /** Health of every source resource right now, or null when the source offers no such read. Writes nothing. */
  async sourceHealth(userId: string, i: { sessionId: string; sourceKind: RemoteSourceKind }): Promise<SourceHealthRow[] | null> {
    const { source } = await this.importer.openSession(userId, i.sessionId, i.sourceKind);
    try {
      return source.healthBaseline ? await source.healthBaseline() : null;
    } finally {
      await source.close();
    }
  }

  /** Resolve a run's scope against a fresh plan into mapping exclusions and skipped stacks, bound by the mapping hash PREFLIGHT re-checks. Read-only. */
  async scopeApply(userId: string, i: Parameters<NonNullable<RunImportPort["scopeApply"]>>[1]): ReturnType<NonNullable<RunImportPort["scopeApply"]>> {
    const plan = await this.discoverPlan(userId, { sessionId: i.sessionId, sourceKind: i.sourceKind, ...(i.dbDataModes ? { dbDataModes: i.dbDataModes } : {}) });
    if (plan.planHash !== i.planHash) throw new ConflictException("plan-changed");
    const scope = resolveScope(plan, i.scope);
    if ("fail" in scope) return { ok: false, code: scope.fail };
    const { mapping, serviceChoices } = applyScope(plan, scope.inScope, { ...(i.serviceChoices ? { serviceChoices: i.serviceChoices } : {}) });
    const res = await this.importer.resolveMapping(userId, {
      sessionId: i.sessionId,
      sourceKind: i.sourceKind,
      planHash: i.planHash,
      targetServerId: i.targetServerId,
      ...(i.environmentId ? { environmentId: i.environmentId } : {}),
      ...(i.reconcile !== undefined ? { reconcile: i.reconcile } : {}),
      ...(i.dbDataModes ? { dbDataModes: i.dbDataModes } : {}),
      ...(i.acks ? { acks: i.acks } : {}),
      ...(i.serverMap ? { serverMap: i.serverMap } : {}),
      mapping,
    });
    return { ok: true, mapping, mappingHash: res.mappingHash, ...(serviceChoices ? { serviceChoices } : {}), kept: scope.kept, excluded: scope.excluded };
  }

  /**
   * The source servers a real run would move from that have no online agent. Uses the plan route's placement facts (a registered server
   * the source server matches, and whether its agent is online). Coolify only: no other source is gated. Writes nothing the plan route
   * does not already write (its session's last-used stamp).
   */
  async sourceAgentGaps(userId: string, i: { sessionId: string; sourceKind: RemoteSourceKind; mapping?: ImportMappingDoc }): ReturnType<NonNullable<RunImportPort["sourceAgentGaps"]>> {
    if (i.sourceKind !== "coolify") return { gaps: [], unverified: false };
    const plan = await this.importer.plan(userId, { sourceKind: i.sourceKind, sessionId: i.sessionId });
    return sourceAgentGaps(plan.preflight ? { items: plan.items, preflight: plan.preflight } : { items: plan.items }, i.mapping);
  }

  resolveMapping(userId: string, input: ImportMappingResolveInput): Promise<ResolvedMapping> {
    return this.importer.resolveMapping(userId, input);
  }

  async storedMappingExists(userId: string, sessionId: string): Promise<boolean> {
    const p = await this.importer.getMapping(userId, sessionId);
    const d = p.doc;
    return !!d && (Object.keys(d.items).length > 0 || Object.keys(d.projects).length > 0 || Object.keys(d.gitSources).length > 0 || d.acks.length > 0);
  }

  /** Mirrors ImporterService.previewServices WITHOUT its `lastUsedAt` touch (a dry-run writes nothing outside its own rows). */
  async previewServices(userId: string, input: { sessionId: string; sourceKind: RemoteSourceKind; choices?: Record<string, ServiceChoice> }): Promise<ServicePreview[]> {
    const { source, session } = await this.importer.openSession(userId, input.sessionId, input.sourceKind);
    try {
      const fleet = await source.discover();
      const plan = planImport(fleet, { sourceKind: session.sourceKind });
      const choices = validateServiceChoices(fleet, plan.items, input.choices);
      const services = [...fleet.services].sort((a, b) => (ns("service", a.serverRef, a.sourceRef) < ns("service", b.serverRef, b.sourceRef) ? -1 : 1));
      return await mapLimit(services, 4, async (svc) => {
        let bundle;
        try {
          bundle = await source.fetchServiceBundle?.(svc.sourceRef);
        } catch {
          bundle = undefined; // a fixed degrade: the card says secretsAvailable:false, never the error text
        }
        return buildServicePreview(svc, choices[ns("service", svc.serverRef, svc.sourceRef)], bundle);
      });
    } finally {
      await source.close();
    }
  }

  async target(userId: string, input: { serverId: string; dnsCredentialId?: string; hosts: readonly string[] }): Promise<TargetFacts> {
    const server = await this.prisma.server.findUnique({ where: { id: input.serverId }, select: { name: true, proxyBind: true, dnsCredentialId: true, capabilities: true, teamId: true, os: true, osVersion: true } });
    if (!server) return { serverName: "", agentOnline: false, capabilities: [], acmeEmailOk: false, proxyBind: null, dnsCredential: false, zones: [] };
    const cfg = await this.proxyConfig.resolveFor(input.serverId).catch(() => null);
    let acmeEmailOk = false;
    try {
      validateAcmeEmail(cfg?.acmeEmail ?? "");
      acmeEmailOk = true;
    } catch {
      acmeEmailOk = false;
    }
    const credentialId = input.dnsCredentialId ?? server.dnsCredentialId ?? undefined;
    const zones = credentialId
      ? await mapLimit([...new Set(input.hosts)].slice(0, ZONE_HOST_CAP), 4, async (host) => {
          try {
            const z = await this.dns.findZoneFor(userId, credentialId, host);
            return { host, zone: z?.zoneName ?? null, sslMode: z?.sslMode ?? null, lookupFailed: false };
          } catch {
            return { host, zone: null, sslMode: null, lookupFailed: true };
          }
        })
      : [];
    // R7: the newest disk reading the agent sent, and what the team can back up to (a failed read is reported as unreadable, never left out)
    const metric = await this.prisma.metric.findFirst({ where: { serverId: input.serverId }, orderBy: { ts: "desc" }, select: { diskUsed: true, diskTotal: true, ts: true } }).catch(() => undefined);
    const disk = metric ? diskReadingOf(metric, Date.now()) : null; // no row and a failed read both say "no reading", which the gate warns about
    const backupDestinations = await this.prisma.backupDestination.count({ where: { teamId: server.teamId } }).catch(() => null);
    return {
      serverName: server.name,
      agentOnline: this.agentWs.isOnline(input.serverId),
      capabilities: server.capabilities ?? [],
      acmeEmailOk,
      proxyBind: server.proxyBind,
      dnsCredential: !!credentialId,
      zones,
      disk,
      os: server.os,
      osVersion: server.osVersion,
      backupDestinations,
    };
  }

  // ── IMPORT ──

  apply(userId: string, input: ImportApplyInput): Promise<{ opId: string }> {
    return this.executor.apply(userId, input);
  }

  async opSnapshot(userId: string, opId: string): Promise<OpSnapshot> {
    const view = await this.executor.status(userId, opId);
    const row = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { meta: true, cancelRequestedAt: true } });
    const meta = metaOf(row?.meta);
    const plan = (view.plan ?? null) as { items?: Array<{ itemRef?: unknown; kind?: unknown; dependsOn?: unknown }> } | null;
    return {
      id: opId,
      rolledBack: typeof meta.rolledBackAt === "string",
      cancelRequested: !!row?.cancelRequestedAt,
      tasks: view.tasks.map((t) => ({
        itemRef: t.itemRef,
        kind: t.kind,
        status: t.status,
        resourceType: t.resourceType,
        resourceId: t.resourceId,
        name: t.name,
        gitStatus: t.git?.status ?? null,
      })),
      planItems: (plan?.items ?? [])
        .filter((i) => typeof i.itemRef === "string" && typeof i.kind === "string")
        .map((i) => {
          const proposed = (i as { proposed?: { domain?: unknown; image?: unknown } }).proposed;
          return {
            itemRef: i.itemRef as string,
            kind: i.kind as string,
            dependsOn: Array.isArray(i.dependsOn) ? i.dependsOn.filter((d): d is string => typeof d === "string") : [],
            ...(proposed && "domain" in proposed ? { domain: typeof proposed.domain === "string" && proposed.domain ? proposed.domain : null } : {}),
            ...(proposed && "image" in proposed ? { image: typeof proposed.image === "string" && proposed.image ? proposed.image : null } : {}),
          };
        }),
    };
  }

  /**
   * The op's DONE compose services with the apps that depend on each: an app depends on a service when it joined the service's private
   * network (what REMAP_ENV's service-host rewrite does). Reads only: `executor.status` is the authorization (op ownership).
   */
  async serviceLinks(userId: string, opId: string): Promise<ServiceLink[]> {
    await this.executor.status(userId, opId);
    const tasks = await this.prisma.bulkTask.findMany({ where: { opId }, select: { itemRef: true, kind: true, status: true, resourceType: true, resourceId: true, result: true } });
    const services = tasks.filter((t) => t.kind === "service" && t.status === "DONE" && t.resourceType === "application" && !!t.resourceId && !!t.itemRef);
    if (services.length === 0) return [];
    const appTasks = tasks.filter((t) => t.kind === "app" && t.status === "DONE" && t.resourceType === "application" && !!t.resourceId);
    const rows = await this.prisma.application.findMany({ where: { id: { in: appTasks.map((t) => t.resourceId as string) } }, select: { id: true, networks: true } });
    const excluded = metaOf((await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { meta: true } }))?.meta).vxExcluded;
    const doneData = new Set(tasks.filter((t) => t.kind === "data" && t.status === "DONE" && !!t.itemRef).map((t) => t.itemRef as string));
    // a copy that is STILL EXPECTED: a streamable copy volume the owner did not exclude and whose data task has not finished. A volume the
    // stream cannot carry is not "expected" (VERIFY lists it as not migrated and the owner acknowledges it there).
    // With the stream switched off no target, transfer or data task can ever exist (VERIFY lists the volumes as not migrated, ackable), and
    // an object store's volume is not streamed at all (Object migration moves the buckets): neither is ever "still expected".
    const streamOn = vxEnabled();
    const dataPending = (itemRef: string, result: unknown): boolean =>
      streamOn && !isObjectStoreResult(result) && serviceVolumesOf(result).some((v) => {
        const ref = serviceVolumeStreamable(v) ? volumeItemRef(itemRef, v.key) : null;
        return !!ref && !(excluded && typeof excluded === "object" && ref in (excluded as Record<string, unknown>)) && !doneData.has(`data:${ref}`);
      });
    const names = await this.prisma.application.findMany({ where: { id: { in: services.map((t) => t.resourceId as string) } }, select: { id: true, name: true } });
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    return services.map((t) => {
      const net = (t.result as { privateNetwork?: { network?: unknown } } | null)?.privateNetwork?.network;
      const network = typeof net === "string" ? net : null;
      const r = (t.result ?? {}) as { serviceDomains?: { applied?: unknown }; hold?: unknown };
      return {
        itemRef: t.itemRef as string,
        appId: t.resourceId as string,
        name: nameOf.get(t.resourceId as string) ?? null,
        objectStore: isObjectStoreResult(t.result),
        dependants: network ? rows.filter((r) => (r.networks ?? []).includes(network)).map((r) => r.id).sort() : [],
        dataPending: dataPending(t.itemRef as string, t.result),
        hold: r.hold === true,
        public: !network && r.hold !== true && typeof r.serviceDomains?.applied === "number" && r.serviceDomains.applied > 0,
      };
    });
  }

  async opsSince(userId: string, serverId: string, since: Date): Promise<string[]> {
    const rows = await this.prisma.bulkOperation.findMany({
      where: { kind: "import", actorId: userId, createdAt: { gte: since }, meta: { path: ["serverId"], equals: serverId } } as Prisma.BulkOperationWhereInput,
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => r.id);
  }

  async cancelOp(userId: string, opId: string): Promise<void> {
    await this.executor.cancel(userId, opId);
  }

  async rollbackOp(userId: string, opId: string, opts: RollbackOptions): Promise<void> {
    await this.executor.rollback(userId, opId, opts);
  }

  async opItems(userId: string, opId: string): Promise<RunReport["items"]> {
    const snap = await this.opSnapshot(userId, opId);
    return snap.tasks
      .filter((t) => t.kind !== "volume")
      .map((t) => {
        const outcome = t.status === "DONE" ? "moved" : t.status === "FAILED" || t.status === "FAILED_VERIFY" ? "failed" : "skipped";
        const kind = t.kind === "app" || t.kind === "database" || t.kind === "service" ? t.kind : (t.itemRef ?? "").startsWith("data:volume") ? "volume" : "database";
        return {
          kind,
          name: (t.name ?? t.itemRef ?? "").slice(0, 300),
          outcome,
          code: outcome === "moved" ? null : `import.task-${t.status.toLowerCase().replace(/_/g, "-")}`,
          evidence: "hub-verified" as const,
        };
      });
  }

  async opDataIntegrity(userId: string, runId: string, opId: string): Promise<RunReport["dataIntegrity"]> {
    const op = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, include: { tasks: true } });
    if (!op || op.kind !== "import" || op.actorId !== userId) return []; // another user's op, or none: nothing is leaked
    const meta = metaOf(op.meta);
    const plan = meta.plan as { items?: unknown } | undefined;
    const dbIds = op.tasks.filter((t) => t.resourceType === "database" && t.resourceId).map((t) => t.resourceId as string);
    const [dbs, transfers, parity] = await Promise.all([
      dbIds.length ? this.prisma.database.findMany({ where: { id: { in: dbIds } }, select: { id: true, engine: true, name: true } }) : Promise.resolve([]),
      this.prisma.migrationVolumeTransfer.findMany({
        where: { opId, destType: { in: ["db-dump", "db-data"] } },
        select: { resourceId: true, destType: true, state: true, partsDone: true, rawBytesDone: true, rawBytesFinal: true, parts: { select: { idx: true, rawOffset: true, rawLen: true, rawSha256: true }, orderBy: { idx: "asc" } } },
      }),
      this.prisma.migrationRunCheck.findMany({ where: { runId, stepKey: "VERIFY", checkId: "db-logical-parity" }, select: { subject: true, status: true, evidence: true } }),
    ]);
    return buildDataIntegrity({
      tasks: op.tasks.map((t) => ({ itemRef: t.itemRef, kind: t.kind, status: t.status, resourceType: t.resourceType, resourceId: t.resourceId, result: t.result })),
      transfers,
      streamRefs: dbStreamModeRefs(meta),
      volumeRefs: dbVolumeModeRefs(plan?.items),
      parity: parity.map((p) => ({ subject: p.subject, status: p.status, evidence: p.evidence && typeof p.evidence === "object" && !Array.isArray(p.evidence) ? (p.evidence as Record<string, unknown>) : null })),
      engineOf: new Map(dbs.map((d) => [d.id, d.engine as string])),
      nameOf: new Map(dbs.map((d) => [d.id, d.name])),
    });
  }

  async mintCommand(userId: string, opId: string, hubBase: string, opts: { reissue: boolean; certs: boolean }) {
    const r = opts.reissue
      ? await this.executor.reissueMigrationToken(userId, opId, hubBase, { certs: opts.certs })
      : await this.executor.mintMigrationToken(userId, opId, hubBase, { certs: opts.certs });
    return { expiresAt: r.expiresAt, command: r.command, ...("commands" in r && r.commands ? { commands: r.commands } : {}) };
  }

  // ── REMAP_ENV ──

  async remapPending(userId: string, opId: string): Promise<boolean> {
    void userId;
    const row = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { meta: true } });
    const undo = metaOf(row?.meta).remapUndo as { undoneAt?: string } | undefined;
    return !!undo && !undo.undoneAt;
  }

  async remapPlan(userId: string, opId: string): Promise<RemapSummary> {
    const pub = await this.executor.remapEnvPlan(userId, opId);
    const apps = pub.apps as Array<{ changes: unknown[]; needsManual: unknown[] }>;
    return {
      planHash: pub.planHash,
      appsToWrite: apps.filter((a) => a.changes.length > 0).length,
      needsManualKeys: apps.reduce((n, a) => n + a.needsManual.length, 0),
      needsManualApps: apps.filter((a) => a.needsManual.length > 0).length,
    };
  }

  async remapApply(userId: string, opId: string, confirmToken: string): Promise<RemapApplyResult> {
    const r = await this.executor.remapEnvApply(userId, opId, confirmToken);
    return { applied: r.failed.length === 0, failed: r.failed.length, linkFailed: r.linkFailed.length };
  }

  async remapUndo(userId: string, opId: string): Promise<boolean> {
    return (await this.executor.remapEnvUndo(userId, opId)).undone;
  }

  // ── DEPLOY_DARK ──

  async appState(userId: string, appId: string): Promise<ResourceState> {
    void userId;
    const a = await this.prisma.application.findUnique({ where: { id: appId }, select: { status: true, name: true } });
    return a ? { exists: true, status: a.status, name: a.name } : { exists: false, status: "NEW", name: null };
  }

  async dbState(userId: string, dbId: string): Promise<ResourceState> {
    void userId;
    const d = await this.prisma.database.findUnique({ where: { id: dbId }, select: { status: true, name: true } });
    return d ? { exists: true, status: d.status, name: d.name } : { exists: false, status: "NEW", name: null };
  }

  async startDb(userId: string, dbId: string): Promise<ResourceState> {
    const v = await this.dbs.provision(userId, dbId);
    return { exists: true, status: v.status, name: v.name };
  }

  stopDb(userId: string, dbId: string): Promise<void> {
    return this.dbs.stop(userId, dbId);
  }

  stopApp(userId: string, appId: string): Promise<void> {
    return this.apps.stop(userId, appId);
  }

  async autoDeployState(userId: string, appId: string): Promise<boolean | null> {
    void userId;
    const a = await this.prisma.application.findUnique({ where: { id: appId }, select: { autoDeploy: true } });
    return a ? a.autoDeploy : null;
  }

  setAutoDeploy(userId: string, appId: string, enabled: boolean): Promise<void> {
    return this.apps.setAutoDeploy(userId, appId, enabled);
  }

  prebuild(userId: string, appId: string): Promise<{ built: boolean }> {
    return this.apps.prebuild(userId, appId).then((r) => ({ built: r.built }));
  }

  async pinImage(userId: string, appId: string, digest: string): Promise<{ pinned: boolean }> {
    const a = await this.prisma.application.findUnique({ where: { id: appId }, select: { source: true, image: true } });
    if (!a || a.source !== "IMAGE" || !a.image) return { pinned: false };
    const ref = pinnedImageRef(a.image, digest);
    if (!ref || ref === a.image) return { pinned: false };
    await this.apps.setSource(userId, appId, { image: ref });
    return { pinned: true };
  }

  async deployments(appId: string, keyPrefix: string): Promise<DeploymentRef[]> {
    const rows = await this.prisma.deployment.findMany({
      where: { appId, idempotencyKey: { startsWith: keyPrefix } },
      select: { id: true, idempotencyKey: true, status: true, trigger: true, requestedBy: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => ({ id: r.id, key: r.idempotencyKey ?? "", status: r.status, trigger: r.trigger, requestedBy: r.requestedBy }));
  }

  async cancelDeployment(userId: string, appId: string, deploymentId: string): Promise<void> {
    await this.apps.cancelDeployment(userId, appId, deploymentId);
  }

  async deploy(userId: string, appId: string, key: string): Promise<DeploymentRef | null> {
    const d = await this.apps.deploy(userId, appId, undefined, key);
    return d ? { id: d.id, key: d.idempotencyKey ?? key, status: d.status, trigger: d.trigger, requestedBy: d.requestedBy } : null;
  }
}

/**
 * Production adapter of the import-side step port (P7 lane A): binds {@link ImportStepsPort} (and the core's
 * {@link RunImportPort}) to the existing importer, executor, apps, databases, DNS and proxy-config services. It adds no
 * business logic: every call is made AS the run's actor and re-checks permissions inside the wrapped service.
 */
import { Injectable } from "@nestjs/common";
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
import { mapLimit } from "../../../importer/sources/map-limit";
import type { ImportApplyInput, ImportMappingResolveInput, RemoteSourceKind, ServiceChoice } from "../../../importer/dto";
import type { ResolvedMapping } from "../../../importer/import-mapping";
import type { ServicePreview } from "../../../importer/service-preview";
import type { RunReport } from "../../core/dto";
import { stable } from "../../core/run-logic";
import type {
  DeploymentRef,
  ImportStepsPort,
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
    const server = await this.prisma.server.findUnique({ where: { id: input.serverId }, select: { name: true, proxyBind: true, dnsCredentialId: true, capabilities: true } });
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
    return { serverName: server.name, agentOnline: this.agentWs.isOnline(input.serverId), capabilities: server.capabilities ?? [], acmeEmailOk, proxyBind: server.proxyBind, dnsCredential: !!credentialId, zones };
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
        .map((i) => ({ itemRef: i.itemRef as string, kind: i.kind as string, dependsOn: Array.isArray(i.dependsOn) ? i.dependsOn.filter((d): d is string => typeof d === "string") : [] })),
    };
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

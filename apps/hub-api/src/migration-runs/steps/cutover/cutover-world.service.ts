import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { AgentWsServer } from "../../../agent-gateway/agent-ws.server";
import { AuditService } from "../../../audit/audit.service";
import { InstanceSettingsService } from "../../../instance/instance-settings.service";
import { containerName } from "../../../deploy/deploy-script";
import type { CoolifyProxySnapshot, SwapState } from "./proxy-swap";

/** An app the run's import op created, with the one fact the PONR rule needs: does it carry data to the target at all? */
export interface OpApp {
  appId: string;
  itemRef: string | null;
  /** The app depends on a database or a volume (whether or not their data task already finished): once it serves traffic
   *  on Tugra it takes writes the source does not have. `CutoverDomain.stateful` is only true while that data is NOT yet
   *  moved, so it cannot decide the point of no return after DATA_FINAL (see cutover.handler). */
  hasData: boolean;
  domain: string | null;
  extraDomains: string[];
  /** Compose service domains (`AppServiceDomain`). */
  serviceHosts: string[];
  clusterId: string | null;
}

export interface SwapRow {
  id: string;
  runId: string;
  serverId: string;
  state: SwapState;
  coolifyProxy: CoolifyProxySnapshot;
  tugraProxyBindBefore: string;
  liveAt: Date | null;
}

export interface ServerFacts {
  id: string;
  name: string;
  teamId: string;
  publicIp: string | null;
  proxyBind: string;
}

/**
 * Everything the cutover-side step handlers touch that no existing service exposes: the swap row, the agent shell,
 * a few read-only queries over the op's resources, backups and container events. One small injectable so the handlers'
 * specs replace it with an in-memory fake (see testing/cutover-world.ts) and never need a database or an agent.
 */
@Injectable()
export class CutoverWorld {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly settings: InstanceSettingsService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  // ── the import op's resources (read-only) ──────────────────────────────────────────────────

  async opApps(opId: string): Promise<OpApp[]> {
    const tasks = await this.prisma.bulkTask.findMany({ where: { opId, kind: "app", status: "DONE", resourceType: "application" }, select: { itemRef: true, resourceId: true, dependsOn: true } });
    const ids = tasks.map((t) => t.resourceId).filter((x): x is string => !!x);
    const apps = await this.prisma.application.findMany({ where: { id: { in: ids } }, select: { id: true, domain: true, extraDomains: true, clusterId: true } });
    const byId = new Map(apps.map((a) => [a.id, a]));
    const svc = await this.prisma.appServiceDomain.findMany({ where: { applicationId: { in: ids } }, select: { applicationId: true, hostname: true } });
    return tasks.flatMap((t) => {
      const a = t.resourceId ? byId.get(t.resourceId) : undefined;
      if (!a) return [];
      const hasData = (t.dependsOn ?? []).some((d) => d.startsWith("database:") || d.startsWith("volume:"));
      const serviceHosts = svc.filter((x) => x.applicationId === a.id).map((x) => x.hostname.toLowerCase());
      return [{ appId: a.id, itemRef: t.itemRef, hasData, domain: a.domain, extraDomains: a.extraDomains ?? [], serviceHosts, clusterId: a.clusterId }];
    });
  }

  async opDatabaseIds(opId: string): Promise<string[]> {
    const tasks = await this.prisma.bulkTask.findMany({ where: { opId, kind: "database", status: "DONE", resourceType: "database" }, select: { resourceId: true } });
    return tasks.map((t) => t.resourceId).filter((x): x is string => !!x);
  }

  /** Container names of the op's apps and databases on the target (the OBSERVE crash watch). */
  async opContainerNames(opId: string): Promise<string[]> {
    const apps = await this.opApps(opId);
    const dbs = await this.opDatabaseIds(opId);
    return [...apps.map((a) => containerName({ id: a.appId })), ...dbs.map((d) => `tugra_db_${d}`)];
  }

  // ── servers and the agent shell ────────────────────────────────────────────────────────────

  async serverFacts(serverId: string): Promise<ServerFacts | null> {
    const s = await this.prisma.server.findUnique({ where: { id: serverId }, select: { id: true, name: true, teamId: true, publicIp: true, proxyBind: true } });
    return s ? { id: s.id, name: s.name, teamId: s.teamId, publicIp: s.publicIp ?? null, proxyBind: s.proxyBind } : null;
  }

  async setProxyBind(serverId: string, bind: "public" | "loopback" | "none"): Promise<void> {
    await this.prisma.server.update({ where: { id: serverId }, data: { proxyBind: bind } });
  }

  /** Run a hub-built script on the host through the agent (`deploy` capability, like every proxy script). */
  async exec(serverId: string, script: string, timeoutMs = 60_000): Promise<{ exitCode: number; output: string }> {
    return this.agentWs.sendCommand(serverId, script, "deploy", timeoutMs);
  }

  /** Other RUNNING apps on the server that this op did not create: restarting the proxy would drop their ingress. */
  async otherLiveApps(serverId: string, excludeAppIds: string[]): Promise<number> {
    return this.prisma.application.count({ where: { serverId, status: "RUNNING", id: { notIn: excludeAppIds } } });
  }

  /** Does the instance already have an ACME account email (env or owner value)? */
  async acmeEmailKnown(): Promise<boolean> {
    return !!(await this.settings.acmeEmailFor(this.config.get<string>("ACME_EMAIL")));
  }

  /** Apply the run's ACME email ONLY when the instance has none (an env or owner value is never overwritten). */
  async applyAcmeEmailIfMissing(email: string): Promise<boolean> {
    const existing = await this.settings.acmeEmailFor(this.config.get<string>("ACME_EMAIL"));
    if (existing) return false;
    await this.settings.update({ acmeEmail: email });
    return true;
  }

  // ── the op's migration token ───────────────────────────────────────────────────────────────

  async migrationTokenActive(opId: string): Promise<boolean> {
    const op = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { migrationTokenHash: true } });
    return !!op?.migrationTokenHash;
  }

  /** Kill the op's live migration token (the same single-row update `MigrationTokenService.revoke` does). Idempotent. */
  async revokeMigrationToken(opId: string, actor: string): Promise<boolean> {
    const res = await this.prisma.bulkOperation.updateMany({ where: { id: opId, migrationTokenHash: { not: null } }, data: { migrationTokenHash: null, migrationTokenExpiresAt: null } });
    if (res.count > 0) await this.audit.log({ actor, action: "import.migration_token.revoke", target: opId, meta: { by: "migration-run" } }).catch(() => undefined);
    return res.count > 0;
  }

  // ── the swap row ───────────────────────────────────────────────────────────────────────────

  private toSwap(r: { id: string; runId: string; serverId: string; state: string; coolifyProxy: Prisma.JsonValue; tugraProxyBindBefore: string; liveAt: Date | null }): SwapRow {
    return { id: r.id, runId: r.runId, serverId: r.serverId, state: r.state as SwapState, coolifyProxy: r.coolifyProxy as unknown as CoolifyProxySnapshot, tugraProxyBindBefore: r.tugraProxyBindBefore, liveAt: r.liveAt };
  }

  async getSwap(runId: string, serverId: string): Promise<SwapRow | null> {
    const r = await this.prisma.migrationRunSwap.findUnique({ where: { runId_serverId: { runId, serverId } } });
    return r ? this.toSwap(r) : null;
  }

  /** Create the PLANNED row (idempotent: a second call returns the existing row, never overwrites its snapshot). */
  async createSwap(runId: string, serverId: string, snapshot: CoolifyProxySnapshot, bindBefore: string): Promise<SwapRow> {
    const existing = await this.getSwap(runId, serverId);
    if (existing) return existing;
    try {
      const r = await this.prisma.migrationRunSwap.create({ data: { runId, serverId, state: "PLANNED", coolifyProxy: snapshot as unknown as Prisma.InputJsonValue, tugraProxyBindBefore: bindBefore } });
      return this.toSwap(r);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const again = await this.getSwap(runId, serverId);
        if (again) return again;
      }
      throw e;
    }
  }

  /** Compare-and-set the swap state; returns false when the row was not in one of `from`. */
  async setSwapState(runId: string, serverId: string, from: readonly SwapState[], to: SwapState): Promise<boolean> {
    const at = new Date();
    const data: Prisma.MigrationRunSwapUpdateManyMutationInput = { state: to };
    if (to === "STARTING_TARGET_PROXY") data.stoppedAt = at;
    if (to === "LIVE") data.liveAt = at;
    if (to === "REVERSED") data.reversedAt = at;
    const r = await this.prisma.migrationRunSwap.updateMany({ where: { runId, serverId, state: { in: [...from] } }, data });
    return r.count === 1;
  }

  // ── observation queries ────────────────────────────────────────────────────────────────────

  async crashEventsSince(serverId: string, containerNames: readonly string[], since: Date): Promise<number> {
    if (containerNames.length === 0) return 0;
    return this.prisma.containerEvent.count({ where: { serverId, containerName: { in: [...containerNames] }, ts: { gte: since } } });
  }

  /** For each database: has Tugra taken at least one SUCCESSFUL backup of it? (the DECOMMISSION precondition) */
  async backupCoverage(databaseIds: readonly string[]): Promise<Array<{ databaseId: string; hasSuccess: boolean }>> {
    if (databaseIds.length === 0) return [];
    const rows = await this.prisma.backup.findMany({ where: { databaseId: { in: [...databaseIds] }, status: "SUCCESS" }, select: { databaseId: true }, distinct: ["databaseId"] });
    const ok = new Set(rows.map((r) => r.databaseId));
    return databaseIds.map((databaseId) => ({ databaseId, hasSuccess: ok.has(databaseId) }));
  }
}

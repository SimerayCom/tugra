import { Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ApplicationsService } from "../applications/applications.service";
import { runTag } from "../deploy/deploy-script";
import { ProxyOpsService } from "../server-ops/proxy-ops.service";
import { CryptoService } from "../crypto/crypto.service";
import { DatabasesService } from "../databases/databases.service";
import { composeProject, composeVolumes } from "../deploy/compose-script";
import { dataMountFor, dbContainerName, pgDataLayout, resolveImage, type DbEngine } from "../databases/database-script";
import { isLiveRunStatus } from "../migration-runs/core/run-contract";
import { exactImageFor } from "../importer/exact-image";
import { writeExactImage } from "../importer/exact-record";
import type { ComposeNetworkRow } from "../deploy/deploy-script";
import type { DeployState, InPlaceWorld, OpApp, OpDatabase, OpService, WorldApp, WorldDatabase, WorldServer, WorldService } from "./inplace-world";

/** Statuses of a guided run that holds its target server. */
const LIVE_RUN = ["RUNNING", "WAITING", "PAUSED", "ABORTING", "ROLLING_BACK", "REVERSING"] as const;
/** Statuses of a takeover that still holds its server. */
const LIVE_TAKEOVER = ["PLANNED", "TESTING", "SWAPPING", "SWAPPED", "VERIFIED", "GIVING_BACK"];

const asList = <T>(v: unknown, pick: (x: Record<string, unknown>) => T | null): T[] =>
  Array.isArray(v) ? v.flatMap((x) => (x && typeof x === "object" ? [pick(x as Record<string, unknown>)] : [])).filter((x): x is T => x !== null) : [];

/**
 * Production binding of {@link InPlaceWorld}: the agent shell, the server's proxy settings, the Tugra apps and the import op's tasks.
 * It adds no rules of its own; the service decides, this only reads and calls the existing services (which re-check permissions themselves).
 */
@Injectable()
export class InPlaceWorldService implements InPlaceWorld {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly apps: ApplicationsService,
    private readonly proxyOps: ProxyOpsService,
    private readonly databases: DatabasesService,
    @Optional() private readonly crypto?: CryptoService,
  ) {}

  async server(serverId: string): Promise<WorldServer | null> {
    const s = await this.prisma.server.findUnique({ where: { id: serverId }, select: { id: true, teamId: true, name: true, status: true, capabilities: true, proxyBind: true } });
    return s ? { id: s.id, teamId: s.teamId, name: s.name, status: s.status, capabilities: s.capabilities, proxyBind: s.proxyBind ?? "public" } : null;
  }

  async opApps(opId: string, teamId: string, serverId: string): Promise<OpApp[] | null> {
    const op = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { id: true } });
    if (!op) return null;
    const tasks = await this.prisma.bulkTask.findMany({ where: { opId, kind: "app", status: "DONE", resourceType: "application" }, select: { itemRef: true, resourceId: true, result: true } });
    const ids = tasks.map((t) => t.resourceId).filter((x): x is string => !!x);
    // only apps of this team that sit on this server: an op of another team contributes nothing
    const rows = await this.prisma.application.findMany({ where: { id: { in: ids }, teamId, serverId }, select: { id: true } });
    const ok = new Set(rows.map((r) => r.id));
    return tasks.flatMap((t) => {
      if (!t.resourceId || !t.itemRef || !ok.has(t.resourceId)) return [];
      const res = t.result && typeof t.result === "object" ? (t.result as Record<string, unknown>) : {};
      const prefix = typeof res.containerPrefix === "string" ? res.containerPrefix : undefined;
      return [{ appId: t.resourceId, itemRef: t.itemRef, ...(prefix ? { containerPrefix: prefix } : {}) }];
    });
  }

  async app(appId: string): Promise<WorldApp | null> {
    const a = await this.prisma.application.findUnique({ where: { id: appId }, select: { id: true, teamId: true, serverId: true, name: true, domain: true, extraDomains: true, volumes: true, hostMounts: true } });
    if (!a) return null;
    const svc = await this.prisma.appServiceDomain.findMany({ where: { applicationId: appId }, select: { hostname: true } });
    return {
      id: a.id,
      teamId: a.teamId,
      serverId: a.serverId,
      name: a.name,
      hosts: [...(a.domain ? [a.domain] : []), ...(a.extraDomains ?? []), ...svc.map((s) => s.hostname)],
      volumes: asList(a.volumes, (x) => (typeof x.name === "string" && typeof x.path === "string" ? { name: x.name, path: x.path } : null)),
      hostMounts: asList(a.hostMounts, (x) => (typeof x.hostPath === "string" && typeof x.containerPath === "string" ? { hostPath: x.hostPath, containerPath: x.containerPath } : null)),
    };
  }

  async opDatabases(opId: string, teamId: string, serverId: string): Promise<OpDatabase[] | null> {
    const op = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { id: true } });
    if (!op) return null;
    const tasks = await this.prisma.bulkTask.findMany({ where: { opId, kind: "database", status: "DONE", resourceType: "database" }, select: { itemRef: true, resourceId: true } });
    const ids = tasks.map((t) => t.resourceId).filter((x): x is string => !!x);
    const rows = await this.prisma.database.findMany({ where: { id: { in: ids }, teamId, serverId }, select: { id: true } });
    const ok = new Set(rows.map((r) => r.id));
    return tasks.flatMap((t) => (t.resourceId && t.itemRef && ok.has(t.resourceId) ? [{ databaseId: t.resourceId, itemRef: t.itemRef }] : []));
  }

  async opServices(opId: string, teamId: string, serverId: string): Promise<OpService[] | null> {
    const op = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { id: true } });
    if (!op) return null;
    const tasks = await this.prisma.bulkTask.findMany({ where: { opId, kind: "service", status: "DONE", resourceType: "application" }, select: { itemRef: true, resourceId: true } });
    const ids = tasks.map((t) => t.resourceId).filter((x): x is string => !!x);
    const rows = await this.prisma.application.findMany({ where: { id: { in: ids }, teamId, serverId }, select: { id: true } });
    const ok = new Set(rows.map((r) => r.id));
    return tasks.flatMap((t) => (t.resourceId && t.itemRef && ok.has(t.resourceId) ? [{ appId: t.resourceId, itemRef: t.itemRef }] : []));
  }

  async service(appId: string): Promise<WorldService | null> {
    const base = await this.app(appId);
    if (!base) return null;
    const a = await this.prisma.application.findUnique({ where: { id: appId }, select: { source: true, composeFile: true, composePath: true, gitUrl: true, composeAdopt: true, clusterId: true, composeNetworks: true } });
    if (!a) return null;
    const row = { id: appId, composeFile: a.composeFile, composeAdopt: a.composeAdopt };
    return {
      ...base,
      project: composeProject(row),
      composeFile: a.composeFile ?? null,
      composeVolumes: composeVolumes(row).map((v) => ({ key: v.key, dockerName: v.dockerName, external: v.external })),
      networks: asList(a.composeNetworks, (x) => (typeof x.network === "string" && typeof x.service === "string" && Array.isArray(x.aliases) ? { network: x.network, service: x.service, aliases: x.aliases.filter((y): y is string => typeof y === "string") } : null)),
      usable: a.source === "COMPOSE" && !!a.composeFile && !a.composePath && !a.gitUrl && !a.composeAdopt && !a.clusterId,
    };
  }

  async setComposeNetworks(userId: string, appId: string, rows: ComposeNetworkRow[]): Promise<void> {
    await this.apps.setComposeNetworks(userId, appId, rows);
  }

  async createAdoptComposeDeployment(appId: string): Promise<string> {
    const a = await this.prisma.application.findUnique({ where: { id: appId }, select: { composeFile: true } });
    if (!a?.composeFile) throw new Error("compose app has no stored compose file");
    const now = new Date();
    const dep = await this.prisma.deployment.create({
      data: {
        appId,
        status: "SUCCESS",
        kind: "DEPLOY",
        trigger: "takeover",
        requestedBy: "takeover",
        startedAt: now,
        durationMs: 0,
        exitCode: 0,
        logs: "service adopted from Coolify (no build)",
        configSnapshot: { snapV: 2, source: "COMPOSE", composeFile: a.composeFile } as object,
      },
    });
    return dep.id;
  }

  async database(databaseId: string): Promise<WorldDatabase | null> {
    const d = await this.prisma.database.findUnique({ where: { id: databaseId }, select: { id: true, teamId: true, serverId: true, name: true, engine: true, version: true, image: true, volumes: true, pgParentMount: true } });
    if (!d) return null;
    const engine = d.engine as DbEngine;
    return {
      id: d.id,
      teamId: d.teamId,
      serverId: d.serverId,
      name: d.name,
      engine: d.engine,
      image: d.image ?? resolveImage(engine, d.version),
      dataMount: dataMountFor(engine, pgDataLayout({ engine: d.engine, version: d.version, image: d.image, pgParentMount: d.pgParentMount })),
      volumes: asList(d.volumes, (x) => (typeof x.name === "string" && typeof x.path === "string" ? { name: x.name, path: x.path } : null)),
    };
  }

  async runDatabase(userId: string, databaseId: string): Promise<{ ok: boolean }> {
    const v = await this.databases.provision(userId, databaseId);
    return { ok: v.status === "RUNNING" };
  }

  /**
   * Stop Tugra's container and PROVE it stopped: the database service swallows a failed `docker stop`, and a Coolify container started on the same
   * data while Tugra's still runs would corrupt it. Anything but a plain "not running" answer is an error, so the give-back never goes on.
   */
  async stopDatabase(userId: string, databaseId: string): Promise<void> {
    await this.databases.stop(userId, databaseId);
    const row = await this.prisma.database.findUnique({ where: { id: databaseId }, select: { serverId: true } });
    if (!row) throw new Error("database not found");
    const r = await this.agentWs.sendCommand(row.serverId, `docker inspect -f '{{.State.Running}}' ${dbContainerName({ id: databaseId })} 2>/dev/null || echo absent`, "deploy", 30_000);
    const out = r.output.trim().split(/\r?\n/).pop() ?? "";
    if (out !== "false" && out !== "absent") throw new Error("database still running");
  }

  async appMentions(appId: string, needles: readonly string[]): Promise<boolean | null> {
    if (!this.crypto) return null;
    const r = await this.prisma.application.findUnique({ where: { id: appId }, select: { env: true, envEnc: true } });
    if (!r) return null;
    try {
      const env = r.envEnc ? (JSON.parse(this.crypto.decrypt(r.envEnc)) as Record<string, unknown>) : ((r.env ?? {}) as Record<string, unknown>);
      if (!env || typeof env !== "object" || Array.isArray(env)) return null;
      // values are only searched, never kept or returned
      return Object.values(env).some((v) => typeof v === "string" && needles.some((n) => v.includes(n)));
    } catch {
      return null;
    }
  }

  exec(serverId: string, script: string, timeoutMs = 60_000): Promise<{ exitCode: number; output: string }> {
    return this.agentWs.sendCommand(serverId, script, "deploy", timeoutMs);
  }

  async setProxyBind(serverId: string, bind: "public" | "loopback" | "none"): Promise<void> {
    await this.prisma.server.update({ where: { id: serverId }, data: { proxyBind: bind } });
  }

  async startProxy(userId: string, serverId: string): Promise<void> {
    await this.proxyOps.start(userId, serverId);
  }

  async proxyStatus(userId: string, serverId: string): Promise<"running" | "stopped" | "absent"> {
    return (await this.proxyOps.status(userId, serverId)).status;
  }

  async serverBusy(serverId: string, exceptRunId?: string): Promise<boolean> {
    const [takeovers, runs] = await Promise.all([
      this.prisma.coolifyTakeover.count({ where: { serverId, status: { in: LIVE_TAKEOVER }, ...(exceptRunId ? { OR: [{ runId: null }, { runId: { not: exceptRunId } }] } : {}) } }),
      this.prisma.migrationRun.count({ where: { targetServerId: serverId, status: { in: [...LIVE_RUN] }, ...(exceptRunId ? { id: { not: exceptRunId } } : {}) } }),
    ]);
    return takeovers + runs > 0;
  }

  async runLive(runId: string): Promise<boolean> {
    const run = await this.prisma.migrationRun.findUnique({ where: { id: runId }, select: { status: true } });
    return !!run && isLiveRunStatus(run.status);
  }

  async createAdoptDeployment(appId: string, commitSha: string | null): Promise<string> {
    const now = new Date();
    const dep = await this.prisma.deployment.create({
      data: { appId, status: "SUCCESS", kind: "DEPLOY", trigger: "takeover", requestedBy: "takeover", startedAt: now, durationMs: 0, exitCode: 0, logs: "image adopted from Coolify (no build)", ...(commitSha ? { commitSha } : {}) },
    });
    await this.prisma.deployment.update({ where: { id: dep.id }, data: { imageTag: runTag({ id: appId }, dep.id) } });
    return dep.id;
  }

  async dropAdoptDeployment(deploymentId: string): Promise<void> {
    await this.prisma.deployment.deleteMany({ where: { id: deploymentId, trigger: "takeover" } });
  }

  async runAdopted(userId: string, appId: string, deploymentId: string): Promise<{ ok: boolean }> {
    const dep = await this.apps.rollback(userId, appId, deploymentId);
    return { ok: dep?.status === "SUCCESS" };
  }

  async rebuild(userId: string, appId: string): Promise<{ deploymentId: string }> {
    const dep = await this.apps.deploy(userId, appId, {});
    return { deploymentId: (dep as { id: string }).id };
  }

  async deployState(deploymentId: string): Promise<DeployState> {
    const d = await this.prisma.deployment.findUnique({ where: { id: deploymentId }, select: { status: true } });
    if (!d) return "unknown";
    return d.status === "QUEUED" || d.status === "RUNNING" || d.status === "SUCCESS" || d.status === "FAILED" ? d.status : "FAILED";
  }

  async pinExact(
    userId: string,
    target: { kind: "app" | "database"; id: string; image: string; repoDigests?: string[]; version?: string } | { kind: "service"; id: string; members: Array<{ service: string; image: string; repoDigests?: string[]; version?: string }> },
  ): Promise<"pinned" | "same" | "unknown" | "refused"> {
    const deps = { prisma: this.prisma, apps: this.apps, databases: this.databases };
    if (target.kind === "service") {
      const members: Record<string, string> = {};
      for (const m of target.members) {
        const e = exactImageFor(m.image, m.repoDigests, m.version);
        if (e) members[m.service] = e.ref;
      }
      return Object.keys(members).length > 0 ? (await writeExactImage(deps, userId, { kind: "service", id: target.id, members })).state : "unknown";
    }
    const e = exactImageFor(target.image, target.repoDigests, target.version);
    return e ? (await writeExactImage(deps, userId, { kind: target.kind, id: target.id, ref: e.ref })).state : "unknown";
  }

  async stopApp(userId: string, appId: string): Promise<void> {
    await this.apps.stop(userId, appId);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  now(): Date {
    return new Date();
  }
}

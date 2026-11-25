import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ApplicationsService } from "../applications/applications.service";
import { runTag } from "../deploy/deploy-script";
import { ProxyOpsService } from "../server-ops/proxy-ops.service";
import type { DeployState, InPlaceWorld, OpApp, WorldApp, WorldServer } from "./inplace-world";

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

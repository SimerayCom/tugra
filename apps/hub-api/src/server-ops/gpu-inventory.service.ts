import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { buildGpuProbeScript } from "./gpu-probe-script";
import { classifyReadiness, isGpuStale, parseGpuProbe, parseStoredInventory, type GpuReport } from "./gpu-inventory";

/** A snapshot older than this is shown as stale (and a writer's page auto-refreshes it). */
export const GPU_TTL_SEC = 600;
/** A refresh within this window of the last one returns the cached report (no agent traffic). */
export const GPU_MIN_INTERVAL_SEC = 15;
const PROBE_TIMEOUT_MS = 45_000;

type GpuRefreshReport = GpuReport & { throttled?: boolean; busy?: boolean };

@Injectable()
export class GpuInventoryService {
  /** In-process single-flight per server. The fixed `tugra-gpuprobe` container name is the cross-process mutex. */
  private readonly inflight = new Map<string, Promise<GpuRefreshReport>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
  ) {}

  /** Cached snapshot + readiness. Any team member; never talks to the agent. A malformed stored row is "unknown". */
  async getReport(userId: string, serverId: string): Promise<GpuReport> {
    const server = await this.load(serverId);
    if (!(await this.access.teamRole(userId, server.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    return this.buildReport(server.gpuInventory, server.gpuCheckedAt);
  }

  /** Run the probe now (writers only: it starts a short-lived container on the host) and persist the result. */
  async refresh(userId: string, serverId: string): Promise<GpuRefreshReport> {
    const server = await this.load(serverId);
    await this.access.requirePermission(userId, server.teamId, "servers:ops");

    const now = new Date();
    if (server.gpuCheckedAt && now.getTime() - server.gpuCheckedAt.getTime() < GPU_MIN_INTERVAL_SEC * 1000) {
      return { ...this.buildReport(server.gpuInventory, server.gpuCheckedAt, now), throttled: true };
    }

    const running = this.inflight.get(serverId);
    if (running) return running;
    const p = this.runProbe(userId, serverId, server.gpuInventory, server.gpuCheckedAt);
    this.inflight.set(serverId, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(serverId);
    }
  }

  private async runProbe(
    userId: string,
    serverId: string,
    prevInventory: unknown,
    prevCheckedAt: Date | null,
  ): Promise<GpuRefreshReport> {
    let r: { exitCode: number; output: string };
    try {
      // Capability "bulk" (revocable per server) — no new capability. A revoked grant is a 403 before anything is signed.
      r = await this.agentWs.sendCommand(serverId, buildGpuProbeScript(), "bulk", PROBE_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof AgentOfflineException || e instanceof ForbiddenException) throw e;
      throw new ServiceUnavailableException("GPU detection failed");
    }
    if (r.exitCode !== 0) throw new ServiceUnavailableException("GPU detection failed");

    const parsed = parseGpuProbe(r.output);
    if (!parsed) throw new ServiceUnavailableException("GPU detection failed");
    if ("busy" in parsed) return { ...this.buildReport(prevInventory, prevCheckedAt), busy: true };

    const checkedAt = new Date();
    await this.prisma.server.update({
      where: { id: serverId },
      data: { gpuInventory: parsed as unknown as Prisma.InputJsonValue, gpuCheckedAt: checkedAt },
    });
    await this.audit.log({ actor: userId, action: "server.gpus.refresh", target: serverId });
    return this.buildReport(parsed, checkedAt, checkedAt);
  }

  private buildReport(stored: unknown, checkedAt: Date | null, now: Date = new Date()): GpuReport {
    // No timestamp = never probed: the row is unknown regardless of what the JSON column holds.
    const inventory = checkedAt ? parseStoredInventory(stored) : null;
    return {
      inventory,
      readiness: classifyReadiness(inventory),
      checkedAt: checkedAt ? checkedAt.toISOString() : null,
      ageSeconds: checkedAt ? Math.max(0, Math.floor((now.getTime() - checkedAt.getTime()) / 1000)) : null,
      stale: isGpuStale(checkedAt, now, GPU_TTL_SEC * 1000),
      ttlSeconds: GPU_TTL_SEC,
    };
  }

  private async load(serverId: string) {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    return server;
  }
}

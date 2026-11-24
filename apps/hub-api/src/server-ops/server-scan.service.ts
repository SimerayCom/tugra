import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import {
  buildDockerScanScript,
  buildHostScanScript,
  buildScanReport,
  parseDockerScan,
  parseHostScan,
  parseStoredReport,
  type DockerScan,
  type HostScanResult,
  type ScanView,
} from "./server-scan";

/** A scan within this window of the last one returns the stored report (no agent traffic). */
export const SCAN_MIN_INTERVAL_SEC = 10;
const DOCKER_TIMEOUT_MS = 30_000;
const HOST_TIMEOUT_MS = 60_000;

/**
 * "Scan this server": a read-only inventory of what runs on a host (containers and compose projects, PM2, CloudPanel /
 * nginx / apache sites, systemd services, listening ports). Never changes the host and never stores env values.
 * Viewing the stored report needs team membership; running a scan needs `servers:ops` (it starts a short-lived
 * helper container), like the GPU probe.
 */
@Injectable()
export class ServerScanService {
  /** In-process single-flight per server. */
  private readonly inflight = new Map<string, Promise<ScanView>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
  ) {}

  /** The stored report. Any team member; never talks to the agent. A malformed stored row is "never scanned". */
  async getView(userId: string, serverId: string): Promise<ScanView> {
    const server = await this.load(serverId);
    if (!(await this.access.teamRole(userId, server.teamId))) throw new ForbiddenException("not a member of this team");
    return this.view(server.scanReport, server.scannedAt);
  }

  async run(userId: string, serverId: string): Promise<ScanView> {
    const server = await this.load(serverId);
    await this.access.requirePermission(userId, server.teamId, "servers:ops");

    if (server.scannedAt && Date.now() - server.scannedAt.getTime() < SCAN_MIN_INTERVAL_SEC * 1000) {
      return this.view(server.scanReport, server.scannedAt);
    }
    const running = this.inflight.get(serverId);
    if (running) return running;
    const p = this.scan(userId, serverId);
    this.inflight.set(serverId, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(serverId);
    }
  }

  private async scan(userId: string, serverId: string): Promise<ScanView> {
    // Capability "bulk" (revocable per server): no new capability. A revoked grant is a 403 before anything is signed.
    const [dockerRes, hostRes] = await Promise.allSettled([
      this.agentWs.sendCommand(serverId, buildDockerScanScript(), "bulk", DOCKER_TIMEOUT_MS),
      this.agentWs.sendCommand(serverId, buildHostScanScript(), "bulk", HOST_TIMEOUT_MS),
    ]);
    for (const r of [dockerRes, hostRes]) {
      if (r.status === "rejected" && (r.reason instanceof AgentOfflineException || r.reason instanceof ForbiddenException)) throw r.reason;
    }

    const docker: DockerScan | null = dockerRes.status === "fulfilled" && dockerRes.value.exitCode === 0 ? parseDockerScan(dockerRes.value.output) : null;
    const host: HostScanResult =
      hostRes.status === "fulfilled" && hostRes.value.exitCode === 0 ? parseHostScan(hostRes.value.output) : { status: "unavailable", reason: "failed" };
    // Neither probe produced anything usable: say so instead of storing an empty report that reads as "nothing runs here".
    if (docker === null && host.status !== "ok") throw new ServiceUnavailableException("server scan failed");

    const scannedAt = new Date();
    const report = buildScanReport({ docker, host, now: scannedAt });
    await this.prisma.server.update({
      where: { id: serverId },
      data: { scanReport: report as unknown as Prisma.InputJsonValue, scannedAt },
    });
    // Counts only: names, images and domains stay out of the audit trail.
    await this.audit.log({
      actor: userId,
      action: "server.scan",
      target: serverId,
      meta: { containers: report.containers.length, software: report.software.length, host: report.host.status },
    });
    return { report };
  }

  private view(stored: unknown, scannedAt: Date | null): ScanView {
    return { report: scannedAt ? parseStoredReport(stored) : null };
  }

  private async load(serverId: string) {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    return server;
  }
}

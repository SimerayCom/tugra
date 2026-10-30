import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { scrubRestoreOutput } from "../backups/backup-script";
import { buildCleanupScript } from "./cleanup-script";

const CLEANUP_TIMEOUT_MS = 300_000;

@Injectable()
export class CleanupRunnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly notifications: NotificationsService,
  ) {}

  /** Current disk usage % from the server's latest metric sample, or null when none has been reported. */
  private async currentDiskPct(serverId: string): Promise<number | null> {
    const m = await this.prisma.metric
      .findFirst({ where: { serverId }, orderBy: { ts: "desc" }, select: { diskUsed: true, diskTotal: true } })
      .catch(() => null);
    if (!m || m.diskTotal <= 0n) return null;
    return (Number(m.diskUsed) / Number(m.diskTotal)) * 100;
  }

  /**
   * Run `docker system prune` on a server; records lastCleanupAt. Returns the agent output.
   * `respectThreshold` (scheduled runs only): when the server has a cleanupThresholdPct, skip the prune
   * unless the latest reported disk usage is at/above it. A manual "Clean now" passes false → always runs.
   * Unknown disk usage (no metric yet) never skips — better to prune than let a filling disk slip through.
   */
  async runCleanup(serverId: string, actor = "scheduler", opts: { respectThreshold?: boolean } = {}): Promise<string> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new Error("server not found");
    if (opts.respectThreshold && server.cleanupThresholdPct != null) {
      const pct = await this.currentDiskPct(serverId);
      if (pct != null && pct < server.cleanupThresholdPct) {
        return `skipped: disk ${pct.toFixed(0)}% below threshold ${server.cleanupThresholdPct}%`;
      }
    }
    let output = "";
    let ok = false;
    try {
      const r = await this.agentWs.sendCommand(
        serverId,
        buildCleanupScript({ volumes: server.cleanupVolumes }),
        "cleanup",
        CLEANUP_TIMEOUT_MS,
      );
      output = r.output.slice(0, 65536);
      ok = r.exitCode === 0;
    } catch (e) {
      output = e instanceof Error ? e.message : "cleanup failed";
    }
    // lastCleanupAt + audit stay UNCONDITIONAL (exit code never gated them before) — only ADD the fire.
    await this.prisma.server
      .update({ where: { id: serverId }, data: { lastCleanupAt: new Date() } })
      .catch(() => undefined);
    await this.audit.log({ actor, action: "server.cleanup", target: serverId });
    // Maintenance event — never critical. Scrub the error tail (agent output can echo host detail).
    await this.notifications
      .fireForEvent(server.teamId, ok ? "docker_cleanup_success" : "docker_cleanup_failed", {
        serverId: server.id,
        serverName: server.name,
        reclaimed: ok ? parseReclaimed(output) : "",
        errorTail: ok ? "" : scrubRestoreOutput(output),
      })
      .catch(() => undefined);
    return output;
  }
}

/** Pull the human "Total reclaimed space" figure docker prints (e.g. "1.2GB"); "" when absent → dropped. */
function parseReclaimed(output: string): string {
  const m = output.match(/Total reclaimed space:\s*([\d.]+\s*[A-Za-z]+)/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

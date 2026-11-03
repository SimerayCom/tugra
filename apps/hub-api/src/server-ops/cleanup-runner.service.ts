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
   * Run a scoped Docker cleanup on a server (dangling-image + build-cache prune — see buildCleanupScript;
   * never `docker system prune` / container / network / tagged-image prune, so stopped managed containers,
   * their networks and the hub-managed rollback images all survive); records lastCleanupAt. Returns the
   * agent output.
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

/** Sum every reclaimed-space figure the multi-step cleanup prints — `docker image/volume prune` emit
 *  "Total reclaimed space: X" and `docker builder prune` emits "Total: X" (a different label) — and
 *  humanize the sum; "" when nothing parseable → dropped from the notification. */
function parseReclaimed(output: string): string {
  const unit: Record<string, number> = {
    B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15,
    KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4, PIB: 1024 ** 5,
  };
  let bytes = 0;
  let found = false;
  for (const m of output.matchAll(/Total(?: reclaimed space)?:\s*([\d.]+)\s*([KMGTP]?i?B)\b/gi)) {
    const mult = unit[m[2].toUpperCase()];
    if (mult == null) continue;
    bytes += parseFloat(m[1]) * mult;
    found = true;
  }
  return found ? humanizeBytes(bytes) : "";
}

/** Short SI-style byte size for a notification (e.g. "1.2GB", "0B") — mirrors docker's own prune output. */
function humanizeBytes(n: number): string {
  if (!(n > 0)) return "0B";
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)}${units[i]}`;
}

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
   * `skipIfDeploying` (scheduled runs only): skip while a deploy is building/running on this server, so a
   * prune never races a build. A manual "Clean now" always proceeds.
   */
  async runCleanup(
    serverId: string,
    actor = "scheduler",
    opts: { respectThreshold?: boolean; skipIfDeploying?: boolean } = {},
  ): Promise<{ ok: boolean; reclaimed: string; output: string }> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new Error("server not found");
    if (opts.respectThreshold && server.cleanupThresholdPct != null) {
      const pct = await this.currentDiskPct(serverId);
      if (pct != null && pct < server.cleanupThresholdPct) {
        return { ok: true, reclaimed: "", output: `skipped: disk ${pct.toFixed(0)}% below threshold ${server.cleanupThresholdPct}%` };
      }
    }
    // Don't prune out from under a build: a running deploy on this server (as its run target OR its build
    // server) leaves dangling layers and cache that the prune could delete mid-build. Best-effort — a DB
    // hiccup fails open and lets the prune run (matching currentDiskPct). Only a scheduled run checks this.
    if (opts.skipIfDeploying) {
      const running = await this.prisma.deployment
        .count({ where: { status: "RUNNING", application: { OR: [{ serverId }, { buildServerId: serverId }] } } })
        .catch(() => 0);
      if (running > 0) {
        await this.audit.log({ actor, action: "server.cleanup", target: serverId, meta: { ok: true, skipped: true, reason: "deploy_running" } });
        return { ok: true, reclaimed: "", output: `skipped: ${running} deploy(s) running on this server` };
      }
    }
    let output = "";
    let reclaimed = "";
    let ok = false;
    try {
      const r = await this.agentWs.sendCommand(
        serverId,
        buildCleanupScript({ volumes: server.cleanupVolumes }),
        "cleanup",
        CLEANUP_TIMEOUT_MS,
      );
      ok = r.exitCode === 0;
      // Parse the FULL output first: each step prints its "Total reclaimed space:" / "Total:" at the END, so
      // a long "Deleted:" list could push the totals past the tail window below and under-report the sum.
      reclaimed = parseReclaimed(r.output);
      // Keep the TAIL (the totals live at the end); a huge deleted-objects list is the least useful part.
      output = r.output.length > 65536 ? `…(truncated)\n${r.output.slice(-65536)}` : r.output;
    } catch (e) {
      output = e instanceof Error ? e.message : "cleanup failed";
    }
    // Only a SUCCESSFUL prune advances lastCleanupAt, so the UI's "Last cleanup" reflects the last run that
    // actually ran — a failed or errored attempt leaves the previous timestamp intact.
    if (ok) {
      await this.prisma.server
        .update({ where: { id: serverId }, data: { lastCleanupAt: new Date() } })
        .catch(() => undefined);
    }
    // Record every real attempt with its outcome, so there is a per-run history (ok / reclaimed / error tail).
    await this.audit.log({
      actor,
      action: "server.cleanup",
      target: serverId,
      meta: { ok, skipped: false, reclaimed, ...(ok ? {} : { error: scrubRestoreOutput(output).slice(-500) }) },
    });
    // Maintenance event — never critical. Scrub the error tail (agent output can echo host detail).
    await this.notifications
      .fireForEvent(server.teamId, ok ? "docker_cleanup_success" : "docker_cleanup_failed", {
        serverId: server.id,
        serverName: server.name,
        reclaimed: ok ? reclaimed : "",
        errorTail: ok ? "" : scrubRestoreOutput(output),
      })
      .catch(() => undefined);
    // Surface the outcome to the caller so "Clean now" can show success vs failure (a failed/timed-out prune
    // used to return only a string and look successful). Scrub the agent output tail on failure.
    return { ok, reclaimed, output: ok ? output : scrubRestoreOutput(output) };
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

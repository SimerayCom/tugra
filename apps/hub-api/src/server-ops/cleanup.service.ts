import {
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CleanupRunnerService } from "./cleanup-runner.service";
import { CleanupSchedulerService } from "./cleanup.scheduler.service";
import { planTargets } from "../bulk/bulk.service";
import type { CleanupConfigInput } from "./dto";

/** Daily at 03:00 — the schedule given to a server that is enabled with no cron or interval of its own, so
 *  "enabled" always means "actually runs" instead of silently never firing. */
const DEFAULT_CLEANUP_CRON = "0 3 * * *";

@Injectable()
export class CleanupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly runner: CleanupRunnerService,
    private readonly scheduler: CleanupSchedulerService,
  ) {}

  async cleanupNow(userId: string, serverId: string): Promise<{ output: string }> {
    await this.requireWrite(userId, serverId);
    const output = await this.runner.runCleanup(serverId, userId);
    return { output };
  }

  async setConfig(userId: string, serverId: string, cfg: CleanupConfigInput): Promise<void> {
    await this.requireWrite(userId, serverId);
    await this.apply(serverId, cfg);
    await this.audit.log({ actor: userId, action: "server.cleanup.config", target: serverId });
  }

  /**
   * Apply the same cleanup schedule to many servers (fleet bulk op). Each server
   * is gated by the caller's role in its team — non-writable / cross-team / unknown
   * servers are SKIPPED (not an error), so partial success is reported cleanly.
   */
  async setConfigBulk(
    userId: string,
    serverIds: string[],
    cfg: CleanupConfigInput,
  ): Promise<{ applied: string[]; skipped: string[] }> {
    const servers = await this.prisma.server.findMany({
      where: { id: { in: serverIds } },
      select: { id: true, teamId: true },
    });
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const plan = planTargets(serverIds, servers, permsByTeam, "servers:ops");
    const applied: string[] = [];
    for (const target of plan) {
      if (!target.run) continue;
      await this.apply(target.serverId, cfg);
      applied.push(target.serverId);
    }
    const skipped = plan.filter((p) => !p.run).map((p) => p.serverId);
    if (applied.length > 0) {
      await this.audit.log({
        actor: userId,
        action: "server.cleanup.config.bulk",
        target: applied.join(","),
        meta: { count: applied.length },
      });
    }
    return { applied, skipped };
  }

  /** Persist the cleanup config + (re)schedule. Caller is responsible for authz.
   *
   *  Every optional field is undefined-means-keep (only an explicitly-sent value is written), so a partial
   *  update that toggles one field no longer wipes the others — intervalHours in particular used to be
   *  cleared on any update that omitted it. And enabling with no schedule at all (no cron, no interval) used
   *  to fall through to unschedule, leaving the server "enabled" but never running; it now gets a default
   *  daily cron so enabled always means it actually runs. */
  private async apply(serverId: string, cfg: CleanupConfigInput): Promise<void> {
    let server = await this.prisma.server.update({
      where: { id: serverId },
      data: {
        cleanupEnabled: cfg.enabled,
        ...(cfg.intervalHours !== undefined ? { cleanupIntervalHours: cfg.intervalHours } : {}),
        ...(cfg.cron !== undefined ? { cleanupCron: cfg.cron } : {}),
        ...(cfg.thresholdPct !== undefined ? { cleanupThresholdPct: cfg.thresholdPct } : {}),
        ...(cfg.volumes !== undefined ? { cleanupVolumes: cfg.volumes } : {}),
      },
    });
    if (server.cleanupEnabled && !server.cleanupCron && !server.cleanupIntervalHours) {
      server = await this.prisma.server.update({ where: { id: serverId }, data: { cleanupCron: DEFAULT_CLEANUP_CRON } });
    }
    // A cron expression drives the schedule when set; otherwise fall back to the plain interval.
    if (server.cleanupEnabled && server.cleanupCron) {
      await this.scheduler.scheduleCron(serverId, server.cleanupCron, server.timezone ?? undefined);
    } else if (server.cleanupEnabled && server.cleanupIntervalHours) {
      await this.scheduler.schedule(serverId, server.cleanupIntervalHours * 3600);
    } else {
      await this.scheduler.unschedule(serverId);
    }
  }

  private async requireWrite(userId: string, serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
  }
}

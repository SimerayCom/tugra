import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CleanupRunnerService } from "./cleanup-runner.service";
import { CleanupSchedulerService } from "./cleanup.scheduler.service";
import type { CleanupConfigInput } from "./dto";

const WRITE: Role[] = [Role.OWNER, Role.ADMIN];

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
    const server = await this.prisma.server.update({
      where: { id: serverId },
      data: {
        cleanupEnabled: cfg.enabled,
        cleanupIntervalHours: cfg.intervalHours ?? null,
        ...(cfg.volumes !== undefined ? { cleanupVolumes: cfg.volumes } : {}),
      },
    });
    if (server.cleanupEnabled && server.cleanupIntervalHours) {
      await this.scheduler.schedule(serverId, server.cleanupIntervalHours * 3600);
    } else {
      await this.scheduler.unschedule(serverId);
    }
    await this.audit.log({ actor: userId, action: "server.cleanup.config", target: serverId });
  }

  private async requireWrite(userId: string, serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    const role = await this.access.teamRole(userId, server.teamId);
    if (!role || !WRITE.includes(role)) {
      throw new ForbiddenException("insufficient role for this server");
    }
  }
}

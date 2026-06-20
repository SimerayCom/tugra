import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { containerName } from "../deploy/deploy-script";

const TASK_TIMEOUT_MS = 300_000;
const shq = (v: string): string => `'${v.replaceAll("'", "'\\''")}'`;

/** Runs a scheduled task inside the app's container via the agent. */
@Injectable()
export class ScheduledTaskRunnerService {
  private readonly logger = new Logger(ScheduledTaskRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly audit: AuditService,
  ) {}

  async runTask(taskId: string): Promise<void> {
    const task = await this.prisma.scheduledTask.findUnique({
      where: { id: taskId },
      include: { application: true },
    });
    if (!task || !task.enabled) return;
    const app = task.application;
    const cmd = `docker exec ${containerName(app)} sh -c ${shq(task.command)}`;
    try {
      await this.agentWs.sendCommand(app.serverId, cmd, "schedule", TASK_TIMEOUT_MS);
      await this.prisma.scheduledTask.update({ where: { id: taskId }, data: { lastRunAt: new Date() } });
      await this.audit.log({ actor: "scheduler", action: "task.run", target: task.appId, meta: { taskId } });
    } catch (e) {
      this.logger.warn(`scheduled task ${taskId} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

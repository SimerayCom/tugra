import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
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
    private readonly notifications: NotificationsService,
  ) {}

  async runTask(taskId: string): Promise<void> {
    const task = await this.prisma.scheduledTask.findUnique({
      where: { id: taskId },
      include: { application: true },
    });
    if (!task || !task.enabled) return;
    const app = task.application;
    const cmd = `docker exec ${containerName(app)} sh -c ${shq(task.command)}`;

    let ran = false;
    let exitCode = 0;
    try {
      const r = await this.agentWs.sendCommand(app.serverId, cmd, "schedule", TASK_TIMEOUT_MS);
      ran = true;
      exitCode = r.exitCode;
      // lastRunAt + audit stay UNCONDITIONAL once the command completed (a non-zero exit was previously a
      // silent "success", so we only ADD a notification — never gate/remove an existing side effect).
      await this.prisma.scheduledTask.update({ where: { id: taskId }, data: { lastRunAt: new Date() } });
      await this.audit.log({ actor: "scheduler", action: "task.run", target: task.appId, meta: { taskId } });
    } catch (e) {
      // A throw is EITHER a transport failure (command never ran → ran=false) OR a post-run DB/audit error
      // (ran=true). The notification below classifies from `ran`+`exitCode`, NOT from reaching this catch,
      // so a post-success infra error is never misreported as a task failure.
      this.logger.warn(`scheduled task ${taskId} failed: ${e instanceof Error ? e.message : e}`);
    }

    // Report the COMMAND outcome (independent of any post-run write error). NO command output is shipped:
    // a scheduled task runs an arbitrary user command whose stdout/stderr can carry app secrets (env vars,
    // tokens, connection strings) that scrubRestoreOutput does NOT redact. The access-controlled openApp
    // deep-link is the safe way to inspect the run — mirrors the deploy template, which likewise never
    // sends raw output to external channels.
    const ok = ran && exitCode === 0;
    await this.notifications
      .fireForEvent(app.teamId, ok ? "scheduled_task_success" : "scheduled_task_failed", {
        taskName: task.name,
        appId: app.id,
        appName: app.name,
        exitCode: ran ? exitCode : "",
      })
      .catch(() => undefined);
  }
}

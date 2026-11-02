import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { containerName } from "../deploy/deploy-script";

const TASK_TIMEOUT_MS = 300_000;
const OUTPUT_TAIL = 16_384; // cap stored run output (arbitrary command stdout) to the last 16 KB
const RUNS_KEPT = 50; // per-task run-history retention — prune older rows after each run
const shq = (v: string): string => `'${v.replaceAll("'", "'\\''")}'`;

/** Runs a scheduled task inside the app's container via the agent. */
@Injectable()
export class ScheduledTaskRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduledTaskRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** On boot, fail any run left RUNNING by a previous hub process — its driver died, so it can never finish
   *  (mirrors the deployment reaper). Single-process hub, so nothing legitimately RUNNING at boot. */
  async onApplicationBootstrap(): Promise<void> {
    const { count } = await this.prisma.scheduledTaskRun.updateMany({
      where: { status: "RUNNING" },
      data: { status: "FAILED", error: "Interrupted: the hub restarted while this run was in progress.", finishedAt: new Date() },
    });
    if (count > 0) this.logger.warn(`reaped ${count} scheduled-task run(s) left RUNNING by a hub restart`);
  }

  /** Keep only the most recent RUNS_KEPT runs for a task; drop the rest so history can't grow unbounded. */
  private async pruneRuns(taskId: string): Promise<void> {
    const old = await this.prisma.scheduledTaskRun.findMany({
      where: { taskId },
      orderBy: { startedAt: "desc" },
      skip: RUNS_KEPT,
      select: { id: true },
    });
    if (old.length) await this.prisma.scheduledTaskRun.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
  }

  /** Run a task once. `force` runs it even when disabled — used by a manual "run now" so an operator can
   *  test a command (or a paused task) without waiting for the cron; the scheduler always calls it unforced.
   *  `trigger` tags the recorded run ("schedule" by default, "manual" for run-now). */
  async runTask(taskId: string, opts: { force?: boolean; trigger?: "schedule" | "manual" } = {}): Promise<void> {
    const task = await this.prisma.scheduledTask.findUnique({
      where: { id: taskId },
      include: { application: true },
    });
    if (!task) return;
    if (!task.enabled && !opts.force) return;
    const app = task.application;
    const cmd = `docker exec ${containerName(app)} sh -c ${shq(task.command)}`;

    // Record this run for the history view. Best-effort: a history-write failure must never stop the task
    // from running, so a null row just means this run isn't recorded.
    const startedAt = new Date();
    const runId = await this.prisma.scheduledTaskRun
      .create({ data: { taskId, status: "RUNNING", trigger: opts.trigger ?? "schedule", startedAt } })
      .then((r) => r.id)
      .catch(() => null);

    let ran = false;
    let exitCode = 0;
    let output = "";
    let errorMsg: string | null = null;
    try {
      const r = await this.agentWs.sendCommand(app.serverId, cmd, "schedule", TASK_TIMEOUT_MS);
      ran = true;
      exitCode = r.exitCode;
      output = r.output ?? "";
      // lastRunAt + audit stay UNCONDITIONAL once the command completed (a non-zero exit was previously a
      // silent "success", so we only ADD a notification — never gate/remove an existing side effect).
      await this.prisma.scheduledTask.update({ where: { id: taskId }, data: { lastRunAt: new Date() } });
      await this.audit.log({ actor: "scheduler", action: "task.run", target: task.appId, meta: { taskId } });
    } catch (e) {
      // A throw is EITHER a transport failure (command never ran → ran=false) OR a post-run DB/audit error
      // (ran=true). The notification below classifies from `ran`+`exitCode`, NOT from reaching this catch,
      // so a post-success infra error is never misreported as a task failure.
      errorMsg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`scheduled task ${taskId} failed: ${errorMsg}`);
    }

    // Finalize the run record from `ran`+`exitCode` (same classification as the notification). Transport
    // failure (!ran) → FAILED with a null exit code + the error message; the output tail is capped so an
    // arbitrary command can't bloat the row. Best-effort: never let a history-write error flip the outcome.
    if (runId) {
      const finishedAt = new Date();
      await this.prisma.scheduledTaskRun
        .update({
          where: { id: runId },
          data: {
            status: ran ? (exitCode === 0 ? "SUCCESS" : "FAILED") : "FAILED",
            exitCode: ran ? exitCode : null,
            output: ran ? output.slice(-OUTPUT_TAIL) : null,
            error: ran ? null : errorMsg,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
          },
        })
        .catch(() => undefined);
      await this.pruneRuns(taskId).catch(() => undefined);
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

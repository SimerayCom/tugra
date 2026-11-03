import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { Application, ScheduledTask, ScheduledTaskRun } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { loadProjectCtx } from "../common/resource-project";
import { ScheduledTasksSchedulerService } from "./scheduled-tasks.scheduler.service";
import { ScheduledTaskRunnerService } from "./scheduled-task-runner.service";
import type { CreateTaskInput, UpdateTaskInput } from "./dto";

export const TaskViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  schedule: z.string(),
  command: z.string(),
  enabled: z.boolean(),
  timeoutSec: z.number().nullable(),
  lastRunAt: z.date().nullable(),
});
export type TaskView = z.infer<typeof TaskViewSchema>;

export const TaskRunViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  trigger: z.string(),
  exitCode: z.number().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
  durationMs: z.number().nullable(),
});
export type TaskRunView = z.infer<typeof TaskRunViewSchema>;

@Injectable()
export class ScheduledTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly scheduler: ScheduledTasksSchedulerService,
    private readonly audit: AuditService,
    private readonly runner: ScheduledTaskRunnerService,
  ) {}

  async list(userId: string, appId: string): Promise<TaskView[]> {
    await this.require(userId, appId);
    const tasks = await this.prisma.scheduledTask.findMany({
      where: { appId },
      orderBy: { createdAt: "asc" },
    });
    return tasks.map(view);
  }

  async create(userId: string, appId: string, dto: CreateTaskInput): Promise<TaskView> {
    await this.requireWrite(userId, appId);
    const task = await this.prisma.scheduledTask.create({
      data: {
        appId,
        name: dto.name,
        schedule: dto.schedule.trim(),
        command: dto.command,
        enabled: dto.enabled ?? true,
        timeoutSec: dto.timeoutSec ?? null,
      },
    });
    if (task.enabled) await this.scheduler.schedule(task.id, task.schedule);
    await this.audit.log({ actor: userId, action: "task.create", target: appId, meta: { taskId: task.id } });
    return view(task);
  }

  async update(userId: string, appId: string, taskId: string, dto: UpdateTaskInput): Promise<TaskView> {
    await this.requireWrite(userId, appId);
    const existing = await this.prisma.scheduledTask.findFirst({ where: { id: taskId, appId } });
    if (!existing) throw new NotFoundException("task not found");
    const task = await this.prisma.scheduledTask.update({
      where: { id: taskId },
      data: {
        name: dto.name ?? undefined,
        schedule: dto.schedule?.trim() ?? undefined,
        command: dto.command ?? undefined,
        enabled: dto.enabled ?? undefined,
        // undefined = keep, null = clear to the 300s default, a number = set. (Not `?? undefined`: that
        // would turn an explicit null into a no-op and the user could never reset to the default.)
        timeoutSec: dto.timeoutSec,
      },
    });
    if (task.enabled) await this.scheduler.schedule(task.id, task.schedule);
    else await this.scheduler.unschedule(task.id);
    await this.audit.log({ actor: userId, action: "task.update", target: appId, meta: { taskId } });
    return view(task);
  }

  async remove(userId: string, appId: string, taskId: string): Promise<void> {
    await this.requireWrite(userId, appId);
    const existing = await this.prisma.scheduledTask.findFirst({ where: { id: taskId, appId } });
    if (!existing) throw new NotFoundException("task not found");
    await this.scheduler.unschedule(taskId);
    await this.prisma.scheduledTask.delete({ where: { id: taskId } });
    await this.audit.log({ actor: userId, action: "task.remove", target: appId, meta: { taskId } });
  }

  /** Trigger a task immediately, out of band of its cron. Runs even when the task is disabled (so an
   *  operator can test a command or a paused job). The run is fire-and-forget — a task command can take up
   *  to the runner's timeout, so we don't block the HTTP request on it; the outcome surfaces via the task's
   *  lastRunAt and the success/failure notification (and, later, run history). */
  async runNow(userId: string, appId: string, taskId: string): Promise<void> {
    await this.requireWrite(userId, appId);
    const task = await this.prisma.scheduledTask.findFirst({ where: { id: taskId, appId } });
    if (!task) throw new NotFoundException("task not found");
    await this.audit.log({ actor: userId, action: "task.run_now", target: appId, meta: { taskId } });
    void this.runner.runTask(taskId, { force: true, trigger: "manual" }).catch(() => undefined);
  }

  /** Execution history for a task (newest first). Gated to writers (apps:config) + read:secrets at the
   *  controller, because a run's `output` is an arbitrary command's stdout and can carry app secrets. */
  async listRuns(userId: string, appId: string, taskId: string): Promise<TaskRunView[]> {
    await this.requireWrite(userId, appId);
    const task = await this.prisma.scheduledTask.findFirst({ where: { id: taskId, appId } });
    if (!task) throw new NotFoundException("task not found");
    const runs = await this.prisma.scheduledTaskRun.findMany({
      where: { taskId },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    return runs.map(runView);
  }

  // ── helpers ──
  private async require(userId: string, appId: string): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("application not found");
    if (!(await this.access.teamRole(userId, app.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    // Per-resource scoping: a restricted member can't read tasks of an app they can't access.
    await this.access.requireResourceAccess(userId, app.teamId, {
      resourceId: app.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, app.environmentId).then((c) => c.projectId),
    });
    return app;
  }

  private async requireWrite(userId: string, appId: string): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("application not found");
    await this.access.requirePermission(userId, app.teamId, 'apps:config');
    return app;
  }
}

function view(t: ScheduledTask): TaskView {
  return {
    id: t.id,
    name: t.name,
    schedule: t.schedule,
    command: t.command,
    enabled: t.enabled,
    timeoutSec: t.timeoutSec,
    lastRunAt: t.lastRunAt,
  };
}

function runView(r: ScheduledTaskRun): TaskRunView {
  return {
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    exitCode: r.exitCode,
    output: r.output,
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
  };
}

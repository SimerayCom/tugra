import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Application, Role, ScheduledTask } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { loadProjectCtx } from "../common/resource-project";
import { ScheduledTasksSchedulerService } from "./scheduled-tasks.scheduler.service";
import type { CreateTaskInput, UpdateTaskInput } from "./dto";

const WRITE: Role[] = [Role.OWNER, Role.ADMIN];

export interface TaskView {
  id: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  lastRunAt: Date | null;
}

@Injectable()
export class ScheduledTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly scheduler: ScheduledTasksSchedulerService,
    private readonly audit: AuditService,
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
    await this.access.requireRole(userId, app.teamId, WRITE);
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
    lastRunAt: t.lastRunAt,
  };
}

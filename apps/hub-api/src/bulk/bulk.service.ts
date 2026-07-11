import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";

const CONCURRENCY = 10;

export interface PlannedTarget {
  serverId: string;
  run: boolean; // false → SKIPPED (unknown server or not writable)
}

/** Decide which selected targets the user may act on — needs the domain permission the bulk op
 *  requires (shared across bulk-run, backup/monitor/cleanup bulk config). Pure → unit-tested. */
export function planTargets(
  serverIds: string[],
  servers: { id: string; teamId: string }[],
  permsByTeam: Map<string, Set<string>>,
  permission: string,
): PlannedTarget[] {
  return serverIds.map((id) => {
    const s = servers.find((x) => x.id === id);
    const perms = s ? permsByTeam.get(s.teamId) : undefined;
    return { serverId: id, run: !!s && (perms?.has(permission) ?? false) };
  });
}

@Injectable()
export class BulkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
  ) {}

  async run(
    userId: string,
    serverIds: string[],
    command: string,
  ): Promise<{ opId: string }> {
    const servers = await this.prisma.server.findMany({
      where: { id: { in: serverIds } },
      select: { id: true, teamId: true },
    });
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const targets = planTargets(serverIds, servers, permsByTeam, "bulk");

    const op = await this.prisma.bulkOperation.create({
      data: { actorId: userId, command },
    });
    const runnable: string[] = [];
    for (const tgt of targets) {
      const task = await this.prisma.bulkTask.create({
        data: {
          opId: op.id,
          serverId: tgt.serverId,
          status: tgt.run ? "PENDING" : "SKIPPED",
        },
      });
      if (tgt.run) runnable.push(task.id);
    }
    await this.audit.log({
      actor: userId,
      action: "bulk.run",
      target: op.id,
      meta: { command, total: serverIds.length, run: runnable.length },
    });

    void this.fanout(runnable, command); // don't block the response
    return { opId: op.id };
  }

  private async fanout(taskIds: string[], command: string): Promise<void> {
    let i = 0;
    const worker = async () => {
      while (i < taskIds.length) {
        const id = taskIds[i++];
        await this.runTask(id, command);
      }
    };
    const n = Math.min(CONCURRENCY, taskIds.length) || 0;
    await Promise.all(Array.from({ length: n }, () => worker()));
  }

  private async runTask(taskId: string, command: string): Promise<void> {
    const t = await this.prisma.bulkTask.findUnique({ where: { id: taskId } });
    if (!t) return;
    await this.prisma.bulkTask.update({
      where: { id: taskId },
      data: { status: "RUNNING", startedAt: new Date() },
    });
    try {
      const r = await this.agentWs.sendCommand(t.serverId, command, "bulk");
      await this.prisma.bulkTask.update({
        where: { id: taskId },
        data: {
          status: "DONE",
          exitCode: r.exitCode,
          output: r.output.slice(0, 65536),
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      await this.prisma.bulkTask.update({
        where: { id: taskId },
        data: {
          status: "FAILED",
          output: e instanceof Error ? e.message : "failed",
          finishedAt: new Date(),
        },
      });
    }
  }

  async get(userId: string, opId: string) {
    const op = await this.prisma.bulkOperation.findUnique({
      where: { id: opId },
      include: { tasks: { orderBy: { serverId: "asc" } } },
    });
    if (!op) throw new NotFoundException("operation not found");
    if (op.actorId !== userId) throw new ForbiddenException("not your operation");
    return op;
  }
}

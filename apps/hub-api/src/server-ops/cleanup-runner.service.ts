import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { buildCleanupScript } from "./cleanup-script";

const CLEANUP_TIMEOUT_MS = 300_000;

@Injectable()
export class CleanupRunnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
  ) {}

  /** Run `docker system prune` on a server; records lastCleanupAt. Returns the agent output. */
  async runCleanup(serverId: string, actor = "scheduler"): Promise<string> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new Error("server not found");
    let output = "";
    try {
      const r = await this.agentWs.sendCommand(
        serverId,
        buildCleanupScript({ volumes: server.cleanupVolumes }),
        "cleanup",
        CLEANUP_TIMEOUT_MS,
      );
      output = r.output.slice(0, 65536);
    } catch (e) {
      output = e instanceof Error ? e.message : "cleanup failed";
    }
    await this.prisma.server
      .update({ where: { id: serverId }, data: { lastCleanupAt: new Date() } })
      .catch(() => undefined);
    await this.audit.log({ actor, action: "server.cleanup", target: serverId });
    return output;
  }
}

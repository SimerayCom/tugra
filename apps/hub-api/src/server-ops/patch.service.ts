import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import {
  buildCheckScript,
  buildUpgradeAllScript,
  buildUpgradeOneScript,
  parseUpgradable,
  type PatchInfo,
} from "./patch-script";

const WRITE: Role[] = [Role.OWNER, Role.ADMIN];
const CHECK_TIMEOUT_MS = 120_000;
const UPGRADE_ALL_TIMEOUT_MS = 600_000;
const UPGRADE_ONE_TIMEOUT_MS = 300_000;

@Injectable()
export class PatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
  ) {}

  async checkUpdates(userId: string, serverId: string): Promise<PatchInfo> {
    await this.requireWrite(userId, serverId);
    const r = await this.agentWs.sendCommand(serverId, buildCheckScript(), "patch", CHECK_TIMEOUT_MS);
    await this.audit.log({ actor: userId, action: "server.patch.check", target: serverId });
    return parseUpgradable(r.output);
  }

  async upgradeAll(userId: string, serverId: string): Promise<{ output: string; exitCode: number }> {
    await this.requireWrite(userId, serverId);
    const r = await this.agentWs.sendCommand(serverId, buildUpgradeAllScript(), "patch", UPGRADE_ALL_TIMEOUT_MS);
    await this.audit.log({ actor: userId, action: "server.patch.apply", target: serverId });
    return { output: r.output.slice(0, 65536), exitCode: r.exitCode };
  }

  async upgradeOne(userId: string, serverId: string, pkg: string): Promise<{ output: string; exitCode: number }> {
    await this.requireWrite(userId, serverId);
    const r = await this.agentWs.sendCommand(serverId, buildUpgradeOneScript(pkg), "patch", UPGRADE_ONE_TIMEOUT_MS);
    await this.audit.log({ actor: userId, action: "server.patch.apply", target: serverId, meta: { pkg } });
    return { output: r.output.slice(0, 65536), exitCode: r.exitCode };
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

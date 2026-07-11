import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { DeployLogHub } from "../agent-gateway/deploy-log.hub";
import {
  buildCheckScript,
  buildUpgradeAllScript,
  buildUpgradeOneScript,
  parseUpgradable,
  type PatchInfo,
} from "./patch-script";

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
    private readonly deployLogs: DeployLogHub,
  ) {}

  async checkUpdates(userId: string, serverId: string): Promise<PatchInfo> {
    await this.requireWrite(userId, serverId);
    const r = await this.agentWs.sendCommand(serverId, buildCheckScript(), "patch", CHECK_TIMEOUT_MS);
    await this.audit.log({ actor: userId, action: "server.patch.check", target: serverId });
    return parseUpgradable(r.output);
  }

  async upgradeAll(userId: string, serverId: string): Promise<{ output: string; exitCode: number }> {
    await this.requireWrite(userId, serverId);
    const r = await this.runStreamed(serverId, buildUpgradeAllScript(), UPGRADE_ALL_TIMEOUT_MS);
    await this.audit.log({ actor: userId, action: "server.patch.apply", target: serverId });
    return r;
  }

  async upgradeOne(userId: string, serverId: string, pkg: string): Promise<{ output: string; exitCode: number }> {
    await this.requireWrite(userId, serverId);
    const r = await this.runStreamed(serverId, buildUpgradeOneScript(pkg), UPGRADE_ONE_TIMEOUT_MS);
    await this.audit.log({ actor: userId, action: "server.patch.apply", target: serverId, meta: { pkg } });
    return r;
  }

  /** Live build-log stream for the server's active patch run (replay + live). */
  async streamLogs(userId: string, serverId: string) {
    await this.requireWrite(userId, serverId);
    return this.deployLogs.subscribe(serverId);
  }

  /** Run a patch command on the agent, streaming its output via DeployLogHub. */
  private async runStreamed(serverId: string, script: string, timeoutMs: number): Promise<{ output: string; exitCode: number }> {
    this.deployLogs.begin(serverId);
    try {
      const r = await this.agentWs.sendCommand(serverId, script, "patch", timeoutMs, (c) =>
        this.deployLogs.push(serverId, c),
      );
      this.deployLogs.finish(serverId, {
        status: r.exitCode === 0 ? "SUCCESS" : "FAILED",
        exitCode: r.exitCode,
        deploymentId: serverId,
      });
      return { output: r.output.slice(0, 65536), exitCode: r.exitCode };
    } catch (e) {
      this.deployLogs.finish(serverId, { status: "FAILED", exitCode: -1, deploymentId: serverId });
      throw e;
    }
  }

  private async requireWrite(userId: string, serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
  }
}

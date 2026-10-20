import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { DeployLogHub } from "../agent-gateway/deploy-log.hub";
import { planTargets } from "../bulk/bulk.service";
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
// Fan-out caps for fleet ops: checks are cheap (parallel more), applies are heavy (fewer at once).
const FLEET_CHECK_CONCURRENCY = 8;
const FLEET_APPLY_CONCURRENCY = 3;

/** Per-server outcome of a fleet update check. `online=false` means the agent wasn't connected. */
export interface FleetPatchCheck {
  serverId: string;
  online: boolean;
  updates?: PatchInfo;
  error?: string;
}

/** Per-server outcome of a fleet update apply. */
export interface FleetPatchApply {
  serverId: string;
  online: boolean;
  exitCode?: number;
  error?: string;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order in the results. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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

  /**
   * Check OS updates across many servers at once (fleet op). Each server is role-gated in its own
   * team via planTargets — non-writable / cross-team / unknown ids are SKIPPED (not an error), so
   * partial coverage is reported cleanly. An offline agent yields `online=false`; a per-server
   * failure is captured as `error` rather than failing the whole batch. Bounded fan-out.
   */
  async checkUpdatesBulk(userId: string, serverIds: string[]): Promise<{ results: FleetPatchCheck[]; skipped: string[] }> {
    const { targets, skipped } = await this.planFleet(userId, serverIds);
    const results = await mapPool(targets, FLEET_CHECK_CONCURRENCY, async (serverId): Promise<FleetPatchCheck> => {
      if (!this.agentWs.isOnline(serverId)) return { serverId, online: false };
      try {
        const r = await this.agentWs.sendCommand(serverId, buildCheckScript(), "patch", CHECK_TIMEOUT_MS);
        return { serverId, online: true, updates: parseUpgradable(r.output) };
      } catch (e) {
        return { serverId, online: true, error: e instanceof Error ? e.message : String(e) };
      }
    });
    if (targets.length > 0) {
      await this.audit.log({ actor: userId, action: "server.patch.check.bulk", target: targets.join(","), meta: { count: targets.length } });
    }
    return { results, skipped };
  }

  /**
   * Apply all OS updates across many servers at once (fleet op). Same role-gating/skip semantics as
   * checkUpdatesBulk; heavier, so a smaller fan-out. Reboots are never triggered here (the agent's
   * upgrade script never reboots), matching the single-server path.
   */
  async upgradeAllBulk(userId: string, serverIds: string[]): Promise<{ results: FleetPatchApply[]; skipped: string[] }> {
    const { targets, skipped } = await this.planFleet(userId, serverIds);
    const results = await mapPool(targets, FLEET_APPLY_CONCURRENCY, async (serverId): Promise<FleetPatchApply> => {
      if (!this.agentWs.isOnline(serverId)) return { serverId, online: false };
      try {
        const r = await this.agentWs.sendCommand(serverId, buildUpgradeAllScript(), "patch", UPGRADE_ALL_TIMEOUT_MS);
        return { serverId, online: true, exitCode: r.exitCode };
      } catch (e) {
        return { serverId, online: true, error: e instanceof Error ? e.message : String(e) };
      }
    });
    if (targets.length > 0) {
      await this.audit.log({ actor: userId, action: "server.patch.apply.bulk", target: targets.join(","), meta: { count: targets.length } });
    }
    return { results, skipped };
  }

  /** Resolve which of the requested servers the caller may operate on (servers:ops per team). */
  private async planFleet(userId: string, serverIds: string[]): Promise<{ targets: string[]; skipped: string[] }> {
    const servers = await this.prisma.server.findMany({ where: { id: { in: serverIds } }, select: { id: true, teamId: true } });
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const plan = planTargets(serverIds, servers, permsByTeam, "servers:ops");
    return {
      targets: plan.filter((p) => p.run).map((p) => p.serverId),
      skipped: plan.filter((p) => !p.run).map((p) => p.serverId),
    };
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

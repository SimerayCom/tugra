import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { buildComposeRestartHealScript, healTargetsFor, parseHealed, type HealTarget } from "./compose-restart-heal";

const HEAL_TIMEOUT_MS = 30_000;
/** Per-server floor between passes: the heal is idempotent and cheap, but a fleet tick every minute is pointless. */
export const HEAL_INTERVAL_MS = 15 * 60 * 1000;
const MAX_TARGETS_PER_COMMAND = 40; // projects per script, to keep one command small on a big server

/**
 * Gives already-running compose members a restart policy without a redeploy (see compose-restart-heal.ts). Runs from the
 * container-health tick. Each server is isolated and best-effort: a failure warns and is retried on the next pass.
 * Never throws.
 */
@Injectable()
export class ComposeRestartHealService {
  private readonly logger = new Logger(ComposeRestartHealService.name);
  private readonly lastRun = new Map<string, number>();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
  ) {}

  async runTick(now = Date.now()): Promise<void> {
    if (this.running) return; // a slow pass is still going: never overlap two loops over the same servers
    this.running = true;
    try {
      const servers = await this.prisma.server.findMany({ where: { status: "ONLINE" }, select: { id: true } });
      for (const server of servers) {
        try {
          if (!this.agentWs.isOnline(server.id)) continue;
          if (now - (this.lastRun.get(server.id) ?? Number.NEGATIVE_INFINITY) < HEAL_INTERVAL_MS) continue;
          this.lastRun.set(server.id, now);
          await this.healServer(server.id);
        } catch (e) {
          this.lastRun.delete(server.id); // retry next tick
          this.logger.warn(`compose restart-policy heal failed for server ${server.id}: ${String(e)}`);
        }
      }
    } catch (e) {
      this.logger.warn(`compose restart-policy heal tick failed: ${String(e)}`);
    } finally {
      this.running = false;
    }
  }

  private async healServer(serverId: string): Promise<void> {
    const apps = await this.prisma.application.findMany({
      where: { serverId, source: "COMPOSE", composeFile: { not: null }, status: { not: "STOPPED" } },
      select: { id: true, composeFile: true, gitUrl: true, composePath: true },
    });
    const targets = healTargetsFor(apps);
    let failed = false;
    for (let i = 0; i < targets.length; i += MAX_TARGETS_PER_COMMAND) {
      const chunk: HealTarget[] = targets.slice(i, i + MAX_TARGETS_PER_COMMAND);
      const r = await this.agentWs.sendCommand(serverId, buildComposeRestartHealScript(chunk), "bulk", HEAL_TIMEOUT_MS);
      if (r.exitCode !== 0) {
        this.logger.warn(`compose restart-policy heal exited ${r.exitCode} on server ${serverId}`);
        failed = true;
        continue;
      }
      const n = parseHealed(r.output);
      if (n > 0) this.logger.log(`compose restart-policy heal: set unless-stopped on ${n} container(s) on server ${serverId}`);
    }
    if (failed) this.lastRun.delete(serverId); // retry next tick, like a thrown failure
  }
}

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { DeployLeaseService } from "../applications/deploy-lease.service";
import { APP_MOVE_TERMINAL } from "../common/app-move-guard";
import { AppMoveRunnerService } from "./app-move-runner.service";

const TICK_MS = 30_000;
/** Moves picked up shortly after boot, once the agents have had a moment to reconnect. */
const BOOT_DELAY_MS = 5_000;

/**
 * "Lose the hub without losing the app": at boot, and every 30 s while agents are offline, re-drives every non-terminal
 * move whose owner is not THIS process (a restarted hub has a new bootId, NULL = released). WHAT happens is decided by
 * the row's phase inside the runner (QUEUED..TRANSFERRING roll back, DEPLOYING adopts or enqueues the move deploy,
 * FINALIZING reruns its idempotent steps, ROLLING_BACK continues) — this service only finds the orphans and gives up on
 * the ones whose needed agent stayed offline past the deadline (FAILED = needs attention).
 */
@Injectable()
export class AppMoveRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AppMoveRecoveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private boot?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly lease: DeployLeaseService,
    private readonly runner: AppMoveRunnerService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    this.boot = setTimeout(() => void this.recover().catch((e: unknown) => this.logger.warn(`move recovery failed: ${e instanceof Error ? e.message : String(e)}`)), BOOT_DELAY_MS);
    this.boot.unref?.();
    this.timer = setInterval(() => void this.recover().catch(() => undefined), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.boot) clearTimeout(this.boot);
  }

  /** One pass. Returns the ids it handed to the runner (for tests). */
  async recover(now = Date.now()): Promise<string[]> {
    const rows = await this.prisma.appMove.findMany({
      where: { phase: { notIn: APP_MOVE_TERMINAL }, OR: [{ ownerId: null }, { ownerId: { not: this.lease.bootId } }] },
      orderBy: { createdAt: "asc" },
    });
    const driven: string[] = [];
    for (const m of rows) {
      if (this.runner.isRunning(m.id)) continue;
      // The agent this phase needs: the source to bring the app back (rollback), the target while deploying.
      const needed = m.phase === "DEPLOYING" ? m.targetServerId : m.phase === "FINALIZING" ? null : m.sourceServerId;
      const pastDeadline = !!m.deadlineAt && m.deadlineAt.getTime() < now;
      if (needed && pastDeadline && !this.agentWs.isOnline(needed)) {
        await this.runner.failNeedsAttention(m.id, "deadline_exceeded");
        continue;
      }
      driven.push(m.id);
      void this.runner.run(m.id);
    }
    return driven;
  }
}

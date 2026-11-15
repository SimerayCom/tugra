import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { purgeMoveSource, retryTargetCleanup } from "./app-move-archive";

const HOURLY_MS = 3600 * 1000;

/**
 * Hourly: (a) remove the archived source volumes of COMPLETED moves once `archiveUntil` has passed (guarded: never when
 * the app runs on that server again or another live move uses it; an offline source is retried next tick), and (b) retry
 * the target cleanup of ROLLED_BACK moves whose leftovers could not be removed (an agent was offline, a volume was in
 * use). A FAILED move is NEVER touched automatically — it needs a human (purge-source clears it).
 */
@Injectable()
export class AppMoveArchiveSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AppMoveArchiveSweeper.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    this.timer = setInterval(() => void this.sweep().catch((e: unknown) => this.logger.warn(`archive sweep failed: ${e instanceof Error ? e.message : String(e)}`)), HOURLY_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep (the hourly timer, and tests). Returns what it did per move id. */
  async sweep(now = new Date()): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const deps = { prisma: this.prisma as never, agentWs: this.agentWs as never };
    const due = await this.prisma.appMove.findMany({ where: { phase: "COMPLETED", sourcePurgedAt: null, archiveUntil: { lt: now } } });
    for (const m of due) out[m.id] = `archive:${await purgeMoveSource(deps, m, { stampWhenLive: true })}`;
    const leftovers = await this.prisma.appMove.findMany({ where: { phase: "ROLLED_BACK", targetPurgedAt: null } });
    for (const m of leftovers) out[m.id] = `target:${await retryTargetCleanup(deps, m)}`;
    return out;
  }
}

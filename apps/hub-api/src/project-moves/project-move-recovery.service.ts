import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { DeployLeaseService } from "../applications/deploy-lease.service";
import { ProjectMoveRunnerService } from "./project-move-runner.service";
import { ProjectMovesService } from "./project-moves.service";

const TICK_MS = 30_000;
const BOOT_DELAY_MS = 8_000;
const HOURLY_MS = 3600_000;
/** A running move beats its heartbeat at least every poll; this long without one means no process is driving it. */
const STALE_MS = 3 * 60_000;

/**
 * "Lose the hub without losing the move": at boot and every 30 s, a move nobody is driving (its hub restarted) is handed back to the
 * runner, which resumes from the stored stages. Hourly, the safety copy of completed moves whose retention passed is removed.
 */
@Injectable()
export class ProjectMoveRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(ProjectMoveRecoveryService.name);
  private timers: Array<ReturnType<typeof setTimeout | typeof setInterval>> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly lease: DeployLeaseService,
    private readonly runner: ProjectMoveRunnerService,
    private readonly moves: ProjectMovesService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    const boot = setTimeout(() => void this.recover().catch((e: unknown) => this.log.warn(`project move recovery failed: ${e instanceof Error ? e.message : String(e)}`)), BOOT_DELAY_MS);
    const tick = setInterval(() => void this.recover().catch(() => undefined), TICK_MS);
    const hourly = setInterval(() => void this.moves.purgeDue().catch(() => undefined), HOURLY_MS);
    for (const t of [boot, tick, hourly]) t.unref?.();
    this.timers = [boot, tick, hourly];
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearTimeout(t as ReturnType<typeof setTimeout>);
  }

  /** One pass. Returns the ids handed to the runner. */
  async recover(now = Date.now()): Promise<string[]> {
    const stale = new Date(now - STALE_MS);
    const rows = await this.prisma.projectMove.findMany({
      where: { phase: { notIn: ["COMPLETED", "ROLLED_BACK", "FAILED"] }, OR: [{ ownerId: null }, { ownerId: { not: this.lease.bootId }, OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: stale } }] }] },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    const handed: string[] = [];
    for (const r of rows) {
      // Release another boot's stale claim so this process can take it.
      if (r.ownerId && r.ownerId !== this.lease.bootId) await this.prisma.projectMove.updateMany({ where: { id: r.id, ownerId: r.ownerId }, data: { ownerId: null } });
      handed.push(r.id);
      void this.runner.run(r.id).catch((e: unknown) => this.log.warn(`project move resume failed: ${e instanceof Error ? e.constructor.name : "unknown"}`));
    }
    return handed;
  }
}

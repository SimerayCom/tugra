import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { SwarmService } from "./swarm.service";
import { NotificationsService } from "../notifications/notifications.service";

const QUEUE = "swarm-status";

/** Periodic fleet-wide Docker Swarm health poll. Mirrors UpdateCheckSchedulerService's single global
 *  repeatable job (a fleet poll is ONE tick over every ACTIVE cluster, not N per-cluster jobs like
 *  backups/cleanup). Fires swarm_degraded (through the existing NotificationChannel path) on a real
 *  ACTIVE→DEGRADED edge, never on a cluster that was already DEGRADED before the tick started (those are
 *  excluded by the `swarmStatus: "ACTIVE"` query, so there is no double-notify). Never throws. */
@Injectable()
export class SwarmSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SwarmSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly swarm: SwarmService,
    private readonly notifications: NotificationsService,
  ) {}

  private connection() {
    const url = new URL(this.config.get<string>("REDIS_URL")!);
    return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
  }

  /** One tick: for every cluster whose DB swarmStatus IS ACTIVE right now, re-check live status and notify on
   *  ACTIVE→DEGRADED. Each cluster is isolated in its own try/catch so one bad manager can't skip the rest. */
  async runTick(): Promise<void> {
    const clusters = await this.prisma.cluster.findMany({
      where: { swarmStatus: "ACTIVE" },
      select: { id: true, name: true, teamId: true },
    });
    for (const c of clusters) {
      try {
        const view = await this.swarm.statusInternal(c.id);
        if (view.swarmStatus === "DEGRADED") {
          const joinedCount = view.nodes.filter((n) => n.swarmRole).length;
          const readyCount = (view.live ?? []).filter((n) => n.state.toLowerCase() === "ready").length;
          await this.notifications.fireForEvent(c.teamId, "swarm_degraded", {
            clusterId: c.id,
            clusterName: c.name,
            readyCount,
            joinedCount,
          });
        }
      } catch (e) {
        this.logger.warn(`swarm status check failed for cluster ${c.id}: ${String(e)}`);
      }
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return; // schedulers disabled in tests (house convention)
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(QUEUE, async () => { await this.runTick(); }, { connection });
    const intervalSec = this.config.get<number>("SWARM_STATUS_INTERVAL_SEC") ?? 60;
    await this.queue.add("swarm-status", {}, { repeat: { every: intervalSec * 1000 } });
    this.logger.log(`scheduled swarm status checks every ${intervalSec}s`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}

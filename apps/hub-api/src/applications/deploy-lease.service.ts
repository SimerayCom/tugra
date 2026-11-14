import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

/** Deployment.phase values (see schema). */
export type DeployPhase = "CLAIMED" | "DISPATCHED" | "RECOVERING";

const HEARTBEAT_MS = 10_000;

/**
 * Identity + heartbeat of THIS hub process as a deploy owner.
 *
 * Every RUNNING Deployment row this process drives carries `ownerId = bootId` (stamped at claim / rollback
 * create). A restarted hub has a different bootId, so at boot — and whenever an agent reconnects — any RUNNING row
 * whose ownerId is not ours (or NULL = released) is provably orphaned by a dead process and may be ADOPTED
 * (DeployRecoveryService) instead of blindly failed. `heartbeatAt` is refreshed while we own rows; it is written
 * for a future multi-hub expiry rule and is NOT used for decisions today (single hub: ownerId alone is exact).
 */
@Injectable()
export class DeployLeaseService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DeployLeaseService.name);
  /** Unique per process start — NOT the telemetry/instance id (which is stable across restarts). */
  readonly bootId = randomUUID();
  readonly bootAt = new Date();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  /** One heartbeat: stamp every RUNNING row we own. Extracted for tests. */
  async beat(): Promise<number> {
    try {
      const { count } = await this.prisma.deployment.updateMany({
        where: { status: "RUNNING", ownerId: this.bootId },
        data: { heartbeatAt: new Date() },
      });
      return count;
    } catch (e) {
      this.logger.warn(`deploy lease heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

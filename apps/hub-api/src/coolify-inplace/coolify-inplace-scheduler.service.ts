import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { CoolifyInPlaceService } from "./coolify-inplace.service";

const TICK_MS = 60_000;

/**
 * A one-minute loop for takeovers that swapped the ports: it works on the new certificates by itself, so Coolify's fallback certificate is
 * never waiting for the owner to press a button. Off in tests; a slow pass never stacks another.
 */
@Injectable()
export class CoolifyInPlaceSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CoolifyInPlaceSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly inplace: CoolifyInPlaceService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.inplace.sweepFallbacks();
    } catch (e) {
      this.logger.warn(`in-place certificate sweep failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.busy = false;
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

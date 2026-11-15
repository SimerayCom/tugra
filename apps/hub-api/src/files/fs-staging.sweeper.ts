import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { sweepStaging } from "./fs-staging";

/** Removes abandoned upload staging files (older than 1h) at boot and then hourly. A hub crash mid-upload is the only way one survives. */
@Injectable()
export class FilesStagingSweeper implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  onModuleInit(): void {
    void sweepStaging();
    this.timer = setInterval(() => void sweepStaging(), 60 * 60 * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

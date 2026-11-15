import { Injectable } from "@nestjs/common";
import { FsRateLimitedException } from "./fs-errors";

/**
 * In-memory sliding-window limiter for file MUTATIONS (60 per minute per user by default). Reads are not limited
 * here (the global throttler covers them). Single-hub, like the rest of the file-op rendezvous state.
 */
@Injectable()
export class FileOpLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max = Number(process.env.FILES_MUTATIONS_PER_MIN) > 0 ? Number(process.env.FILES_MUTATIONS_PER_MIN) : 60,
    private readonly windowMs = 60_000,
  ) {}

  /** Record one mutation for `userId`, or throw 429 with the seconds until the oldest hit leaves the window. */
  take(userId: string, now = Date.now()): void {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(userId) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.max) {
      this.hits.set(userId, list);
      throw new FsRateLimitedException(Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000)));
    }
    list.push(now);
    this.hits.set(userId, list);
    if (this.hits.size > 10_000) this.sweep(now); // bound memory under many distinct users
  }

  private sweep(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [u, list] of this.hits) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length === 0) this.hits.delete(u);
      else this.hits.set(u, kept);
    }
  }
}

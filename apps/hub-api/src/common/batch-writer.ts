import { Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * A bounded in-memory write buffer for TELEMETRY only (host / container metric samples). Rows are flushed in
 * one multi-row statement every `flushMs`, or earlier once `flushRows` are waiting. The buffer can never grow
 * without bound: past `maxBuffered` the OLDEST rows are dropped (and counted) so a dead database costs bounded
 * memory instead of an OOM. Never use this for data a user would miss (deploys, auth, audit, backups, app data).
 *
 * Loss window (stated, not hidden): a hub crash (SIGKILL/OOM) loses at most the rows buffered since the last
 * flush (<= `flushMs` of samples, 5 s by default). A graceful stop (SIGTERM -> onModuleDestroy) flushes first.
 * A database outage keeps up to `maxBuffered` rows (oldest dropped beyond that, see `stats().dropped`).
 */
export interface BatchWriterOptions<T> {
  name: string;
  /** Insert these rows (<= `chunk` per call). A throw means "not written". */
  write: (rows: T[]) => Promise<void>;
  flushMs: number;
  /** Flush early once this many rows wait. */
  flushRows: number;
  /** Hard cap on buffered rows; the oldest are dropped beyond it. */
  maxBuffered: number;
  /** Rows per `write` call (keeps a statement under the bind-parameter limit). Default 500. */
  chunk?: number;
  logger?: Logger;
}

export interface BatchWriterStats {
  buffered: number;
  flushed: number;
  dropped: number; // overflow (DB down too long)
  rejected: number; // rows the database refused for a data reason (never retried)
  failedFlushes: number;
}

// Prisma error codes that mean "the database / pool is unavailable right now" (retry later), not "this row is bad".
const TRANSIENT_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2028", "P2034"]);

/** True when retrying the same rows later can succeed (outage / pool timeout / deadlock); false for a bad row
 *  (constraint, value too long, missing parent such as a server deleted while its samples were buffered). */
export function isTransientDbError(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientValidationError) return false;
  if (e instanceof Prisma.PrismaClientKnownRequestError) return TRANSIENT_CODES.has(e.code);
  return true; // initialization/unknown/rust-panic/network: assume the database, not the data
}

export class BatchWriter<T> {
  private buf: T[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private inFlight: Promise<void> | null = null;
  private flushed = 0;
  private dropped = 0;
  private rejected = 0;
  private failedFlushes = 0;
  private lastWarnAt = 0;
  private readonly chunk: number;
  private readonly logger: Logger;

  constructor(private readonly o: BatchWriterOptions<T>) {
    this.chunk = Math.max(1, o.chunk ?? 500);
    this.logger = o.logger ?? new Logger(`BatchWriter:${o.name}`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.o.flushMs);
    this.timer.unref?.();
  }

  push(row: T): void {
    this.buf.push(row);
    this.enforceCap();
    if (this.buf.length >= this.o.flushRows && !this.inFlight) void this.flush();
  }

  pushMany(rows: T[]): void {
    if (rows.length === 0) return;
    for (const r of rows) this.buf.push(r);
    this.enforceCap();
    if (this.buf.length >= this.o.flushRows && !this.inFlight) void this.flush();
  }

  stats(): BatchWriterStats {
    return { buffered: this.buf.length, flushed: this.flushed, dropped: this.dropped, rejected: this.rejected, failedFlushes: this.failedFlushes };
  }

  /** Flush everything buffered now. Serialized (one flush at a time); never throws. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.buf.length === 0) return Promise.resolve();
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Stop the timer and write what is left (graceful shutdown). Bounded: a dead DB is not retried here. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // The in-flight flush (if any) may have failed and requeued: one more pass writes the remainder.
    await this.flush();
    await this.flush();
  }

  private async run(): Promise<void> {
    // Drain in rounds so rows pushed while we write ride the next round, not the next interval.
    for (let round = 0; round < 20 && this.buf.length > 0; round++) {
      const batch = this.buf;
      this.buf = [];
      for (let i = 0; i < batch.length; i += this.chunk) {
        const retry = await this.writePart(batch.slice(i, i + this.chunk));
        if (retry.length > 0) {
          // DB unavailable: put the unwritten rows AND the rest back in front (order kept), stop for this interval.
          this.buf = retry.concat(batch.slice(i + this.chunk), this.buf);
          this.enforceCap();
          this.failedFlushes++;
          return;
        }
      }
    }
  }

  /** Writes one chunk; returns the rows that must be retried later (empty = handled: written or rejected). */
  private async writePart(part: T[]): Promise<T[]> {
    try {
      await this.o.write(part);
      this.flushed += part.length;
      return [];
    } catch (e) {
      if (isTransientDbError(e)) {
        this.warn(`flush failed (${part.length} rows kept for retry): ${(e as Error)?.message ?? e}`);
        return part;
      }
      // A bad row must not poison its neighbours or be retried forever: isolate it.
      if (part.length === 1) {
        this.rejected++;
        this.warn(`row rejected by the database: ${(e as Error)?.message ?? e}`);
        return [];
      }
      for (let i = 0; i < part.length; i++) {
        try {
          await this.o.write([part[i]]);
          this.flushed++;
        } catch (e2) {
          if (isTransientDbError(e2)) {
            this.warn(`flush failed during isolation: ${(e2 as Error)?.message ?? e2}`);
            return part.slice(i); // the database went away mid-isolation: keep the unwritten remainder
          }
          this.rejected++;
          this.warn(`row rejected by the database: ${(e2 as Error)?.message ?? e2}`);
        }
      }
      return [];
    }
  }

  private enforceCap(): void {
    const over = this.buf.length - this.o.maxBuffered;
    if (over <= 0) return;
    // Drop a slice (not one row per push) so a sustained overflow costs one splice per ~10% of the cap.
    const n = over + Math.ceil(this.o.maxBuffered * 0.1);
    this.buf.splice(0, n);
    this.dropped += n;
    this.warn(`buffer full (database unavailable?): dropped ${n} oldest rows (${this.dropped} total)`);
  }

  private warn(msg: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 30_000) return; // one line per 30 s however many rows fail
    this.lastWarnAt = now;
    this.logger.warn(`${this.o.name}: ${msg}`);
  }
}

/** Telemetry flush interval: TELEMETRY_FLUSH_MS (default 5000, clamped to 1-30 s). */
export function telemetryFlushMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TELEMETRY_FLUSH_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(30_000, Math.max(1000, Math.round(n))) : 5000;
}

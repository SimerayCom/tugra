import { Injectable } from "@nestjs/common";
import type { RelayRegistration } from "../../app-moves/volume-relay.service";

/** How one in-flight part ended (computed once, after BOTH the target receive and the relay finished). */
export type PartOutcome = { ok: true; bytes: number } | { ok: false; retryable: boolean; reason: string };

/** One part the hub is currently relaying for a transfer: the relay rendezvous plus the target receive command. */
export interface InflightPart {
  transferId: string;
  idx: number;
  rawOffset: number;
  rawLen: number;
  rawSha256: string;
  size: number;
  sha256: string;
  reg: RelayRegistration;
  /** Resolves with the outcome once the target's receive command and the relay have both finished. Never rejects. */
  settled: Promise<PartOutcome>;
  /** Abort the part: fail the relay (both ends) and cancel the target receive command. Idempotent. */
  cancel(reason: Error): void;
  startedAt: number;
}

/** One throwaway part of a link speed test (never recorded, never applied; its staging is removed at the end). */
export interface SpeedtestPart {
  key: string;
  idx: number;
  size: number;
  reg: RelayRegistration;
  settled: Promise<PartOutcome>;
  startedAt: number;
  cancel(reason: Error): void;
}

/**
 * In-memory map of the parts being relayed (one per transfer: parts are strictly sequential) plus the last idx this
 * process registered per transfer. Memory is the point: the relay itself is memory-only, so a hub restart loses both
 * the rendezvous and this map by design, and the migrator simply re-registers the part it still holds in its buffer.
 */
@Injectable()
export class VxPartRegistry {
  private readonly inflight = new Map<string, InflightPart>();
  private readonly seen = new Map<string, number>();
  private readonly speed = new Map<string, SpeedtestPart>();
  private readonly speedBytes = new Map<string, number>();

  getSpeed(key: string): SpeedtestPart | undefined {
    return this.speed.get(key);
  }
  setSpeed(p: SpeedtestPart): void {
    this.speed.set(p.key, p);
    this.speedBytes.set(p.key, (this.speedBytes.get(p.key) ?? 0) + p.size);
  }
  deleteSpeed(key: string): void {
    this.speed.delete(key);
  }
  /** Total compressed bytes this test has staged on the target so far (the hub caps it). */
  speedtestBytes(key: string): number {
    return this.speedBytes.get(key) ?? 0;
  }
  endSpeed(key: string): void {
    this.speed.get(key)?.cancel(new Error("speed test ended"));
    this.speed.delete(key);
    this.speedBytes.delete(key);
  }

  get(transferId: string): InflightPart | undefined {
    return this.inflight.get(transferId);
  }

  set(p: InflightPart): void {
    this.inflight.set(p.transferId, p);
    this.seen.set(p.transferId, p.idx);
  }

  /** Forget the in-flight part (after commit or failure). Only removes the entry the caller still owns. */
  delete(transferId: string, p?: InflightPart): void {
    if (p && this.inflight.get(transferId) !== p) return;
    this.inflight.delete(transferId);
  }

  /** Cancel + drop whatever is in flight for the transfer (a retry of the same part, an abort, a reset, a lost lease). */
  cancel(transferId: string, reason: Error): void {
    const cur = this.inflight.get(transferId);
    if (!cur) return;
    this.inflight.delete(transferId);
    cur.cancel(reason);
  }

  /** Note that this process has dealt with part `idx` of the transfer without relaying it (the stat shortcut found it staged). */
  markSeen(transferId: string, idx: number): void {
    this.seen.set(transferId, idx);
  }

  /** Has THIS process ever registered a part for the transfer? false right after a hub restart (the stat shortcut applies). */
  hasSeen(transferId: string): boolean {
    return this.seen.has(transferId);
  }

  forget(transferId: string): void {
    this.cancel(transferId, new Error("transfer closed"));
    this.seen.delete(transferId);
  }

  get size(): number {
    return this.inflight.size;
  }
}

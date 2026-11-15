import { Injectable, NotFoundException, OnModuleDestroy, StreamableFile, UnprocessableEntityException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { PassThrough, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { byteCounter } from "../files/fs-transfer";
import { mintRelayPath, newRelayId, verifyRelaySig, type RelayClaim, type RelayRole } from "./volume-relay-sig";

/** Idle limit: no byte moved and no peer arrived for this long => the rendezvous fails and BOTH ends are destroyed. */
export const RELAY_IDLE_MS = 120_000;
/** A minted URL's validity (kept well inside the signature's 10 min horizon). */
export const RELAY_TTL_SEC = 540;
/** Hard ceiling on a rendezvous' life, whatever happens (a part over a very slow link still has to finish). */
const RELAY_MAX_LIFE_MS = 30 * 60 * 1000;
const PIPE_HWM = 1024 * 1024;

interface Rendezvous {
  id: string;
  srcServerId: string;
  dstServerId: string;
  moveId: string;
  volIdx: number;
  part: number;
  size: number;
  sha256: string;
  exp: number; // unix seconds
  createdMs: number;
  /** The ONLY buffer: source bytes in, target bytes out, <= 1 MiB at rest (backpressure does the rest). */
  pass: PassThrough;
  used: Record<RelayRole, boolean>;
  settled: boolean;
  bytes: number;
  idle?: NodeJS.Timeout;
  done: { resolve: (r: RelayResult) => void; reject: (e: Error) => void };
}

export interface RelayResult {
  bytes: number;
  sha256: string;
}

export interface RelayRegistration {
  /** `busy`: the hub-wide concurrency cap is reached; retry with backoff (not a failure). */
  busy: false;
  id: string;
  /** Relative signed paths: the source agent PUTs to `srcPath`, the target agent GETs `dstPath`. */
  srcPath: string;
  dstPath: string;
  /** Resolves once the source's PUT is fully relayed AND the target consumed every byte; rejects on any failure. */
  done: Promise<RelayResult>;
  /** Abort: fail `done` and destroy both ends. Idempotent. */
  cancel(reason: Error): void;
}

/** A transfer whose hub-computed sha256 differs from the claimed one (answered 422 to the source). */
class ShaMismatchError extends Error {
  constructor() {
    super("sha256 mismatch");
  }
}

/**
 * Memory-only rendezvous between the source agent's PUT and the target agent's GET of ONE part. Either side may arrive
 * first (the other is awaited up to the idle limit); bytes are piped through a <= 1 MiB buffer, so the source's curl is
 * throttled to the target's write speed and nothing ever rests on the hub's disk. Every request on the agent-facing
 * routes is verified against an HMAC over the exact claim, is single-use per role, and every failure is the SAME 404 (no
 * existence/role/signature oracle). A failed/aborted side destroys BOTH ends so both agent commands fail and the move
 * rolls back; only a request whose signature VERIFIED can fail a rendezvous (garbage never kills a live transfer).
 */
@Injectable()
export class VolumeRelayService implements OnModuleDestroy {
  private readonly map = new Map<string, Rendezvous>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {
    this.sweepTimer = setInterval(() => this.sweep(Date.now()), 30_000);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
    for (const rv of [...this.map.values()]) this.fail(rv, new Error("hub shutting down"));
  }

  private secret(): string {
    const s = this.config.get<string>("SECRETS_ENCRYPTION_KEY");
    if (!s) throw new Error("SECRETS_ENCRYPTION_KEY is required");
    return s;
  }

  private maxConcurrent(): number {
    const n = Number(this.config.get("MOVE_MAX_CONCURRENT_RELAYS") ?? 2);
    return Number.isInteger(n) && n >= 1 ? n : 2;
  }

  private claimOf(rv: Rendezvous, role: RelayRole): RelayClaim {
    return { id: rv.id, role, serverId: role === "src" ? rv.srcServerId : rv.dstServerId, moveId: rv.moveId, volIdx: rv.volIdx, part: rv.part, size: rv.size, sha256: rv.sha256 };
  }

  /** Open a rendezvous for one part and mint its two signed paths. `busy` when the hub-wide cap is reached. */
  register(
    o: { moveId: string; volIdx: number; part: number; size: number; sha256: string; srcServerId: string; dstServerId: string },
    nowMs = Date.now(),
  ): RelayRegistration | { busy: true } {
    if (this.map.size >= this.maxConcurrent()) return { busy: true };
    let resolve!: (r: RelayResult) => void;
    let reject!: (e: Error) => void;
    const done = new Promise<RelayResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    done.catch(() => undefined); // never an unhandled rejection; the owner awaits it explicitly
    const rv: Rendezvous = {
      id: newRelayId(),
      srcServerId: o.srcServerId,
      dstServerId: o.dstServerId,
      moveId: o.moveId,
      volIdx: o.volIdx,
      part: o.part,
      size: o.size,
      sha256: o.sha256,
      exp: Math.floor(nowMs / 1000) + RELAY_TTL_SEC,
      createdMs: nowMs,
      pass: new PassThrough({ highWaterMark: PIPE_HWM }),
      used: { src: false, dst: false },
      settled: false,
      bytes: 0,
      done: { resolve, reject },
    };
    // The target hung up (or the stream died) before the last byte left the buffer: fail the whole rendezvous.
    rv.pass.once("close", () => {
      // pass.errored carries the ROOT cause when a failing pipeline destroyed the buffer (e.g. the sha mismatch).
      if (!rv.pass.readableEnded) this.fail(rv, rv.pass.errored ?? new Error("relay closed before the part completed"));
    });
    rv.pass.on("error", () => undefined); // the failure is reported through fail()/done, never as an unhandled 'error'
    this.map.set(rv.id, rv);
    this.touch(rv);
    return {
      busy: false,
      id: rv.id,
      srcPath: mintRelayPath(this.secret(), this.claimOf(rv, "src"), rv.exp),
      dstPath: mintRelayPath(this.secret(), this.claimOf(rv, "dst"), rv.exp),
      done,
      cancel: (reason: Error) => this.fail(rv, reason),
    };
  }

  /** Look up + authenticate + single-use claim for one role. Throws the uniform 404 for EVERY failure. */
  private claim(id: unknown, expRaw: unknown, sig: unknown, role: RelayRole, nowMs: number): Rendezvous {
    try {
      if (typeof id !== "string" || typeof expRaw !== "string" || typeof sig !== "string") throw new Error();
      const rv = this.map.get(id);
      const exp = Number(expRaw);
      if (!rv || rv.settled || rv.used[role] || !Number.isInteger(exp) || exp !== rv.exp) throw new Error();
      if (!verifyRelaySig(this.secret(), this.claimOf(rv, role), exp, sig, nowMs)) throw new Error();
      rv.used[role] = true; // flipped atomically (single-threaded) on the first VALID hit
      this.touch(rv);
      return rv;
    } catch {
      throw new NotFoundException();
    }
  }

  /** The TARGET agent GETs the part. Returns at once; the body flows when the source's PUT delivers it. */
  serveToTarget(id: unknown, exp: unknown, sig: unknown, nowMs = Date.now()): StreamableFile {
    const rv = this.claim(id, exp, sig, "dst", nowMs);
    const file = new StreamableFile(rv.pass, { type: "application/octet-stream", length: rv.size });
    // A mid-body failure must tear the connection down (never a clean end, never a JSON body the agent could
    // mistake for part data); and nothing about the URL is logged.
    file.setErrorHandler((_err, res) => {
      (res as unknown as { destroy?: () => void }).destroy?.();
    });
    file.setErrorLogger(() => undefined);
    return file;
  }

  /**
   * The SOURCE agent PUTs the part. Resolves (-> 204) only after the target consumed the stream to its end, so a
   * successful source curl implies the target read every byte.
   */
  async receiveFromSource(id: unknown, exp: unknown, sig: unknown, req: IncomingMessage, nowMs = Date.now()): Promise<void> {
    const rv = this.claim(id, exp, sig, "src", nowMs);
    if (req.headers["content-length"] !== String(rv.size) || req.headers["transfer-encoding"]) {
      this.fail(rv, new Error("content-length mismatch"));
      throw new NotFoundException();
    }
    const hash = createHash("sha256");
    let mismatch = false;
    const verifier = new Transform({
      highWaterMark: PIPE_HWM,
      transform: (chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) => {
        hash.update(chunk);
        rv.bytes += chunk.length;
        this.touch(rv);
        cb(null, chunk);
      },
      flush: (cb: TransformCallback) => {
        if (hash.digest("hex") !== rv.sha256) {
          mismatch = true;
          return cb(new Error("sha256 mismatch"));
        }
        cb();
      },
    });
    try {
      // The end of the pipeline (pass.end()) only happens after the count AND the hash were verified, so the target
      // never sees a clean end of a part the hub knows is wrong.
      await pipeline(req, byteCounter(rv.size), verifier, rv.pass);
      await this.drained(rv);
    } catch (e) {
      this.fail(rv, mismatch ? new ShaMismatchError() : e instanceof Error ? e : new Error("relay failed"));
      if (mismatch) throw new UnprocessableEntityException();
      throw new NotFoundException();
    }
    this.settleOk(rv);
  }

  /** Resolves when the target has consumed the whole part ('end' of the readable side); rejects if the buffer died. */
  private drained(rv: Rendezvous): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (rv.pass.readableEnded) return resolve();
      const onEnd = (): void => {
        cleanup();
        resolve();
      };
      const onFail = (): void => {
        cleanup();
        reject(new Error("relay closed before the target read the whole part"));
      };
      const cleanup = (): void => {
        rv.pass.off("end", onEnd);
        rv.pass.off("close", onFail);
        rv.pass.off("error", onFail);
      };
      rv.pass.once("end", onEnd);
      rv.pass.once("close", onFail);
      rv.pass.once("error", onFail);
    });
  }

  private settleOk(rv: Rendezvous): void {
    if (rv.settled) return;
    rv.settled = true;
    clearTimeout(rv.idle);
    this.map.delete(rv.id);
    rv.done.resolve({ bytes: rv.bytes, sha256: rv.sha256 });
  }

  private touch(rv: Rendezvous): void {
    clearTimeout(rv.idle);
    rv.idle = setTimeout(() => this.fail(rv, new Error("relay idle timeout")), RELAY_IDLE_MS);
    rv.idle.unref?.();
  }

  /** Fail a rendezvous: drop it, destroy BOTH ends (the PassThrough carries both), reject its owner. Idempotent. */
  private fail(rv: Rendezvous, err: Error): void {
    if (rv.settled) return;
    rv.settled = true;
    clearTimeout(rv.idle);
    this.map.delete(rv.id);
    rv.pass.destroy(err);
    rv.done.reject(err);
  }

  /** Drop rendezvous that were never used past their expiry, or have outlived the hard ceiling. */
  sweep(nowMs: number): void {
    for (const rv of [...this.map.values()]) {
      const unused = !rv.used.src && !rv.used.dst;
      if ((unused && rv.exp * 1000 <= nowMs) || nowMs - rv.createdMs > RELAY_MAX_LIFE_MS) this.fail(rv, new Error("relay expired"));
    }
  }

  /** Live rendezvous (tests, metrics). */
  get size(): number {
    return this.map.size;
  }
}

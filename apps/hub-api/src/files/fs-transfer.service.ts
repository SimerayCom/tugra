import { Injectable, NotFoundException, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableFile } from "@nestjs/common";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { byteCounter, mintXferPath, newXferId, verifyXferSig, type XferClaim, type XferDir } from "./fs-transfer";

interface Transfer {
  id: string;
  dir: XferDir;
  serverId: string;
  appId: string;
  size: number;
  sha256: string;
  exp: number; // unix seconds
  used: boolean;
  stagedPath?: string; // to-agent: the staged upload the agent GETs
  sink?: ServerResponse; // from-agent: the browser response the agent's PUT is piped into
  headers?: Record<string, string>;
  settle?: { resolve: () => void; reject: (e: Error) => void };
}

export interface DownloadRegistration {
  /** The relative signed path to hand the agent. */
  path: string;
  /** Resolves when the agent's PUT has been fully relayed to the browser; rejects (and the browser response is
   *  destroyed) on any mismatch or error. */
  done: Promise<void>;
  /** Abort: fail `done` and tear the browser response down (headers not yet sent => caller sends a JSON error). */
  cancel(reason: Error): void;
}

const DEFAULT_TTL_SEC = 15 * 60;

/**
 * In-memory rendezvous between a browser request and the agent's HTTP transfer (single hub, like `fsPending`; a
 * hub restart mid-transfer fails the op and the staged files are swept). Every transfer is single-use and expires.
 * Every failure on the agent-facing routes is the SAME 404 (no existence/direction/signature oracle).
 */
@Injectable()
export class FsTransferService implements OnModuleDestroy {
  private readonly transfers = new Map<string, Transfer>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {
    this.sweepTimer = setInterval(() => this.sweep(Date.now()), 30_000);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  private secret(): string {
    const s = this.config.get<string>("SECRETS_ENCRYPTION_KEY");
    if (!s) throw new Error("SECRETS_ENCRYPTION_KEY is required");
    return s;
  }

  private claimOf(t: Transfer): XferClaim {
    return { id: t.id, dir: t.dir, serverId: t.serverId, size: t.size, sha256: t.sha256 };
  }

  /** Register a staged upload for the agent to pull. */
  registerUpload(o: { serverId: string; appId: string; stagedPath: string; size: number; sha256: string }, ttlSec = DEFAULT_TTL_SEC, nowMs = Date.now()): { id: string; path: string } {
    const t: Transfer = { id: newXferId(), dir: "to-agent", serverId: o.serverId, appId: o.appId, size: o.size, sha256: o.sha256, exp: Math.floor(nowMs / 1000) + ttlSec, used: false, stagedPath: o.stagedPath };
    this.transfers.set(t.id, t);
    return { id: t.id, path: mintXferPath(this.secret(), this.claimOf(t), t.exp) };
  }

  /** Register a download: the agent will PUT exactly `size` bytes, which are piped into `sink` (the browser response). */
  registerDownload(
    o: { serverId: string; appId: string; size: number; sink: ServerResponse; headers: Record<string, string> },
    ttlSec = DEFAULT_TTL_SEC,
    nowMs = Date.now(),
  ): DownloadRegistration & { id: string } {
    const t: Transfer = { id: newXferId(), dir: "from-agent", serverId: o.serverId, appId: o.appId, size: o.size, sha256: "", exp: Math.floor(nowMs / 1000) + ttlSec, used: false, sink: o.sink, headers: o.headers };
    let settle!: { resolve: () => void; reject: (e: Error) => void };
    const done = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    done.catch(() => undefined); // never an unhandled rejection; the owner awaits it explicitly
    t.settle = settle;
    this.transfers.set(t.id, t);
    return {
      id: t.id,
      path: mintXferPath(this.secret(), this.claimOf(t), t.exp),
      done,
      cancel: (reason: Error) => this.fail(t, reason),
    };
  }

  /** Forget a transfer (the staged FILE is the caller's to delete). Idempotent. */
  release(id: string): void {
    this.transfers.delete(id);
  }

  /** Look up + authenticate + single-use claim. Throws a uniform 404 for EVERY failure. */
  private claim(id: unknown, expRaw: unknown, sig: unknown, dir: XferDir, nowMs: number): Transfer {
    try {
      if (typeof id !== "string" || typeof expRaw !== "string" || typeof sig !== "string") throw new Error();
      const t = this.transfers.get(id);
      const exp = Number(expRaw);
      if (!t || t.dir !== dir || t.used || !Number.isInteger(exp) || exp !== t.exp) throw new Error();
      if (!verifyXferSig(this.secret(), this.claimOf(t), exp, sig, nowMs)) throw new Error();
      t.used = true; // flipped atomically (single-threaded) on the first valid hit
      return t;
    } catch {
      throw new NotFoundException();
    }
  }

  /** The agent GETs a staged upload. */
  serveToAgent(id: unknown, exp: unknown, sig: unknown, nowMs = Date.now()): StreamableFile {
    const t = this.claim(id, exp, sig, "to-agent", nowMs);
    if (!t.stagedPath) throw new NotFoundException();
    return new StreamableFile(createReadStream(t.stagedPath), { type: "application/octet-stream", length: t.size });
  }

  /** The agent PUTs a download body; it is relayed to the browser as it arrives (no data at rest on the hub). */
  async receiveFromAgent(id: unknown, exp: unknown, sig: unknown, req: IncomingMessage, nowMs = Date.now()): Promise<void> {
    const t = this.claim(id, exp, sig, "from-agent", nowMs);
    const sink = t.sink;
    if (!sink || req.headers["content-length"] !== String(t.size)) {
      this.fail(t, new Error("transfer header mismatch"));
      throw new NotFoundException();
    }
    if (sink.headersSent || sink.destroyed) {
      this.fail(t, new Error("client gone"));
      throw new NotFoundException();
    }
    for (const [k, v] of Object.entries(t.headers ?? {})) sink.setHeader(k, v);
    // pipeline() destroys its LAST stream on any error, so the browser response must not be that stream: a failure
    // before the first byte would otherwise kill the socket and the typed JSON error could never be delivered. A thin
    // wrapper takes the hit instead; fail() then strips the download headers (nothing sent yet: the caller answers with
    // a typed JSON error) or destroys the response (bytes already sent: the browser sees a FAILED download).
    const relay = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        if (sink.destroyed) return cb(new Error("client gone"));
        if (sink.write(chunk)) return cb();
        const resume = (): void => {
          sink.off("drain", resume);
          sink.off("close", resume);
          cb(sink.destroyed ? new Error("client gone") : null);
        };
        sink.once("drain", resume);
        sink.once("close", resume);
      },
      final: (cb) => {
        sink.end(); // only reached when every byte arrived and the count matched
        cb();
      },
    });
    sink.on("error", () => undefined); // the wrapper, not pipeline(), owns the sink now: a late socket error must not be unhandled
    const onSinkClose = (): void => {
      relay.destroy(new Error("client gone"));
    };
    sink.once("close", onSinkClose);
    try {
      await pipeline(req, byteCounter(t.size), relay);
    } catch (e) {
      // Never end the browser response cleanly on a failed relay: the browser must see a FAILED download.
      this.fail(t, e instanceof Error ? e : new Error("relay failed"));
      throw new NotFoundException();
    } finally {
      sink.off("close", onSinkClose);
    }
    t.settle?.resolve();
    this.transfers.delete(t.id);
  }

  private fail(t: Transfer, err: Error): void {
    this.transfers.delete(t.id);
    if (t.sink && !t.sink.destroyed) {
      if (t.sink.headersSent) {
        t.sink.destroy(); // mid-body: the browser must see a FAILED download, never a clean end
      } else {
        // Nothing sent yet: strip the download headers so the owner can still answer with a typed JSON error.
        for (const k of Object.keys(t.headers ?? {})) t.sink.removeHeader(k);
      }
    }
    t.settle?.reject(err);
  }

  /** Drop expired transfers (failing a pending download so its owner unblocks). */
  sweep(nowMs: number): void {
    for (const t of [...this.transfers.values()]) {
      if (t.exp * 1000 <= nowMs) this.fail(t, new Error("transfer expired"));
    }
  }

  get size(): number {
    return this.transfers.size;
  }
}

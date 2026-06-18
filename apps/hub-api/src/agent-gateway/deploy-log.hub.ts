import { Injectable } from "@nestjs/common";
import { Observable, Subject } from "rxjs";

/** A live build-log event for a deployment. */
export type DeployLogEvent =
  | { type: "chunk"; data: string }
  | {
      type: "done";
      status: "SUCCESS" | "FAILED";
      exitCode: number;
      deploymentId: string;
    };

const MAX_BUFFER = 64 * 1024;
const CLEANUP_MS = 30_000;

interface DeployStream {
  buffer: string[];
  bufferBytes: number;
  capped: boolean;
  subject: Subject<DeployLogEvent>;
  done: boolean;
  doneEvent?: Extract<DeployLogEvent, { type: "done" }>;
  cleanupTimer?: NodeJS.Timeout;
}

/**
 * In-memory pub/sub for live deployment logs, keyed by appId (one active deploy
 * per app — deploys are serialized). Agent command_log chunks are pushed here;
 * SSE subscribers replay the buffer-so-far then follow live until the deploy
 * finishes. Entries self-clean a short while after completion. The full log is
 * still persisted to the DB by the deploy path (history + fallback).
 */
@Injectable()
export class DeployLogHub {
  private readonly streams = new Map<string, DeployStream>();

  /** Start (or restart) a stream for an app's deploy. */
  begin(appId: string): void {
    this.dispose(appId);
    this.streams.set(appId, {
      buffer: [],
      bufferBytes: 0,
      capped: false,
      subject: new Subject<DeployLogEvent>(),
      done: false,
    });
  }

  /** Append a live chunk: buffered (capped) for replay + emitted live (uncapped). */
  push(appId: string, chunk: string): void {
    const s = this.streams.get(appId);
    if (!s || s.done) return;
    if (s.bufferBytes < MAX_BUFFER) {
      const room = MAX_BUFFER - s.bufferBytes;
      if (chunk.length <= room) {
        s.buffer.push(chunk);
        s.bufferBytes += chunk.length;
      } else {
        s.buffer.push(chunk.slice(0, room));
        s.bufferBytes = MAX_BUFFER;
      }
    } else if (!s.capped) {
      s.capped = true;
      s.buffer.push("\n…(truncated)");
    }
    s.subject.next({ type: "chunk", data: chunk });
  }

  /** Mark the deploy finished, notify subscribers, and schedule cleanup. */
  finish(
    appId: string,
    result: { status: "SUCCESS" | "FAILED"; exitCode: number; deploymentId: string },
  ): void {
    const s = this.streams.get(appId);
    if (!s || s.done) return;
    s.done = true;
    s.doneEvent = { type: "done", ...result };
    s.subject.next(s.doneEvent);
    s.subject.complete();
    s.cleanupTimer = setTimeout(() => this.streams.delete(appId), CLEANUP_MS);
  }

  /**
   * Subscribe to an app's live deploy stream. Returns null when there is no
   * active or recently-finished stream (caller falls back to the persisted log).
   * `replay` is everything emitted so far; `live` follows new events.
   */
  subscribe(
    appId: string,
  ): { replay: DeployLogEvent[]; live: Observable<DeployLogEvent> } | null {
    const s = this.streams.get(appId);
    if (!s) return null;
    const replay: DeployLogEvent[] = s.buffer.map((data) => ({ type: "chunk", data }));
    if (s.doneEvent) replay.push(s.doneEvent);
    return { replay, live: s.subject.asObservable() };
  }

  private dispose(appId: string): void {
    const s = this.streams.get(appId);
    if (!s) return;
    if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
    if (!s.done) s.subject.complete();
    this.streams.delete(appId);
  }
}

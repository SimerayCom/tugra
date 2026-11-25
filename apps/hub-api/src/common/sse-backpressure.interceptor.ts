import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, takeWhile } from "rxjs";

const SSE_METADATA = "__sse__"; // @nestjs/common constants (not re-exported)

/** How many bytes may be queued for a client that is not reading before the stream is closed (per connection). */
export const SSE_STALL_MAX_BYTES = 4 * 1024 * 1024;

/** Approximate wire size of one SSE message. */
function sizeOf(v: unknown): number {
  const data = (v as { data?: unknown } | null)?.data;
  if (typeof data === "string") return data.length;
  return data === undefined ? 0 : 1024;
}

/**
 * Close an SSE stream whose client stopped reading. Nest writes every emitted message to the response and ignores the
 * `false` return of `write()`, so a producer that is faster than a stalled client (a background tab, a dead proxy hop, a
 * chatty `docker logs -f`) queues the whole difference in hub memory for as long as the stream lives (up to 30 minutes).
 * While the response reports it needs a drain, every message is counted; past `maxBytes` the stream is completed, which
 * runs the source's teardown (e.g. kills the agent's follow process). A client that is merely slow never trips this:
 * the counter resets as soon as the response drains. Pure operator so it is testable without HTTP.
 */
export function stallGuard<T>(isStalled: () => boolean, maxBytes = SSE_STALL_MAX_BYTES) {
  return (source: Observable<T>): Observable<T> => {
    let stalledBytes = 0;
    return source.pipe(
      takeWhile((v) => {
        if (!isStalled()) {
          stalledBytes = 0;
          return true;
        }
        stalledBytes += sizeOf(v);
        return stalledBytes <= maxBytes;
      }),
    );
  };
}

/** Applies {@link stallGuard} to every `@Sse()` route (log tails, metrics, update progress, deploy logs). */
@Injectable()
export class SseBackpressureInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "http" || !Reflect.getMetadata(SSE_METADATA, ctx.getHandler())) return next.handle();
    const res = ctx.switchToHttp().getResponse<{ writableNeedDrain?: boolean }>();
    return next.handle().pipe(stallGuard<unknown>(() => res.writableNeedDrain === true));
  }
}

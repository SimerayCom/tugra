import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { ApiError } from "./api-error";

/** Reason phrases for the status codes the API actually emits; falls back to a generic label. */
const REASON: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  423: "Locked",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};
function reason(status: number): string {
  return REASON[status] ?? (status >= 500 ? "Server Error" : "Error");
}

/** A plain object's own string field, if present. */
function strField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Normalize EVERY thrown error into the single {@link ApiError} shape `{ statusCode, error, message }`:
 *  - HttpException → its exact `getStatus()` + its body (message kept verbatim as string | string[]),
 *    guaranteeing an `error` field; any extra keys on the body are preserved (strict superset).
 *  - A framework/`http-errors` error that carries a 4xx numeric status and is safe to expose (e.g. the
 *    body parser's malformed-JSON 400 or payload-too-large 413) → that status, preserving its message.
 *  - Anything else → a constant 500 whose body never leaks internals; the real error is logged server-side.
 *
 * Registered app-wide via APP_FILTER. On an already-committed response (an SSE stream mid-flight) it writes
 * no body — it just ends the response — so it can never corrupt an open `text/event-stream`.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("ApiExceptionFilter");

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // WebSocket/RPC contexts are not ours (Tugra's ws servers are raw, not Nest gateways) — rethrow.
    if (host.getType() !== "http") throw exception;

    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    const { status, body } = this.normalize(exception, req);

    // Headers already flushed (SSE mid-stream, or a @Res handler): never write a JSON body on top.
    if (res?.headersSent || res?.writableEnded) {
      try {
        res.end?.();
      } catch {
        /* nothing more we can do */
      }
      return;
    }
    this.httpAdapterHost.httpAdapter.reply(res, body, status);
  }

  private normalize(exception: unknown, req: { method?: string; url?: string }): { status: number; body: ApiError } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resp = exception.getResponse();
      if (typeof resp === "string") {
        return { status, body: { statusCode: status, error: reason(status), message: resp } };
      }
      const obj = (resp ?? {}) as Record<string, unknown>;
      const rawMsg = obj.message;
      const message: string | string[] =
        typeof rawMsg === "string" || Array.isArray(rawMsg) ? (rawMsg as string | string[]) : reason(status);
      // Superset: keep any extra keys, then pin the three canonical fields + the authoritative status.
      return { status, body: { ...obj, statusCode: status, error: strField(obj, "error") ?? reason(status), message } };
    }

    // Express / http-errors (body parser etc.): preserve an exposable 4xx status instead of masking it as 500.
    const e = exception as { status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown };
    const num = typeof e?.status === "number" ? e.status : typeof e?.statusCode === "number" ? e.statusCode : undefined;
    if (num !== undefined && num >= 400 && num < 500 && e?.expose === true) {
      const message = typeof e.message === "string" && e.message ? e.message : reason(num);
      return { status: num, body: { statusCode: num, error: reason(num), message } };
    }

    // Unknown/unexpected → log the real error server-side (stack only, never request body/headers) and
    // return a constant, leak-free 500. The path is logged WITHOUT its query string, which can carry
    // one-time secrets (e.g. an OAuth `code`/`state` on a callback).
    const detail = exception instanceof Error ? exception.stack : String(exception);
    const path = (req?.url ?? "?").split("?")[0];
    this.logger.error(`${req?.method ?? "?"} ${path} -> 500`, detail);
    return { status: 500, body: { statusCode: 500, error: reason(500), message: "Internal server error" } };
  }
}

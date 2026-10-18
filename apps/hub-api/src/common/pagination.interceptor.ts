import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { map, type Observable } from "rxjs";
import { PAGINATED_KEY, PAGINATION_MAX } from "./pagination.decorator";

/**
 * Opt-in, NON-BREAKING pagination for list endpoints. Runs only for GET requests on handlers marked with
 * `@Paginated()`. When the caller sends a valid `?limit`, the handler's bare-array body is sliced to
 * `[offset, offset+limit)` (offset from the opaque `?cursor`) and `X-Total-Count` / `X-Limit` /
 * `X-Next-Cursor` headers are set. With no/invalid `?limit` the body is returned untouched (full list).
 *
 * Slice-only, post-handler: it runs after the service's authorization + `?q` filtering and after the
 * controller-level RedactSecretsInterceptor, so it can only HIDE rows the caller could already see — it
 * never re-queries, widens scope, or un-redacts. The cursor is a positional offset over the fully
 * in-memory array, so this bounds response SIZE, not DB/service work (not a scalability feature).
 */
@Injectable()
export class PaginationInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "http") return next.handle();
    const req = ctx.switchToHttp().getRequest();
    if (req?.method !== "GET") return next.handle();
    const paginated = this.reflector.getAllAndOverride<boolean>(PAGINATED_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!paginated) return next.handle();

    const limit = parseLimit(req.query?.limit);
    if (limit === null) return next.handle(); // no/invalid ?limit → full list (opt-in, lenient — never 400)
    const offset = parseCursor(req.query?.cursor);
    const res = ctx.switchToHttp().getResponse();

    return next.handle().pipe(
      map((body) => {
        // Only ever slice a plain array; leave envelopes/streams/anything-else untouched.
        if (!Array.isArray(body) || res.headersSent) return body;
        const total = body.length;
        const page = body.slice(offset, offset + limit);
        res.setHeader("X-Total-Count", String(total));
        res.setHeader("X-Limit", String(limit));
        if (offset + limit < total) res.setHeader("X-Next-Cursor", encodeCursor(offset + limit));
        return page;
      }),
    );
  }
}

/** A valid limit is a 1–6 digit positive integer string; anything else (float, hex, `1e3`, array, 0) → null
 *  (meaning "no pagination"). A value above the cap is clamped to PAGINATION_MAX. */
export function parseLimit(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, PAGINATION_MAX);
}

/** Decode the opaque offset cursor defensively — any malformed/negative/oversized value yields offset 0,
 *  never an exception. */
export function parseCursor(raw: unknown): number {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return 0;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    if (!/^\d{1,15}$/.test(decoded)) return 0;
    const n = Number.parseInt(decoded, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

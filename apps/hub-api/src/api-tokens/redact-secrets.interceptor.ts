import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { map, type Observable } from "rxjs";
import { canReadSecrets } from "./scopes";

/**
 * Null out named secret fields in a controller's JSON responses UNLESS the caller may read secrets
 * (`read:secrets`/`admin` scope, or a browser session whose scopes are ["*"]). Applied once per resource
 * controller via `@UseInterceptors(new RedactSecretsInterceptor(["webhookSecret", ...]))`, so it covers
 * every view-returning handler — including the objects returned by create/provision/expose mutations —
 * without touching each handler. Only affects scope-limited PATs; sessions see everything unchanged.
 *
 * Field-name based, applied only to THIS controller's own view types, so it never masks an unrelated
 * field. Walks the top level + array elements (view responses are flat objects or arrays of them).
 */
@Injectable()
export class RedactSecretsInterceptor implements NestInterceptor {
  constructor(private readonly fields: string[]) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "http") return next.handle();
    const scopes: string[] = ctx.switchToHttp().getRequest()?.user?.scopes ?? [];
    if (canReadSecrets(scopes)) return next.handle();
    return next.handle().pipe(map((body) => this.redact(body)));
  }

  private redact(body: unknown): unknown {
    if (Array.isArray(body)) return body.map((x) => this.redact(x));
    if (body && typeof body === "object") {
      const out = { ...(body as Record<string, unknown>) };
      for (const f of this.fields) if (f in out) out[f] = null;
      return out;
    }
    return body;
  }
}

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { auditContext, type AuditCtx } from "./audit-context";

/**
 * Establishes the per-request audit context (how the caller authenticated — a PAT, with its token id, or a
 * browser session) so AuditService.log can stamp it onto every entry written while the handler runs. Registered
 * globally; it runs AFTER the auth guard, so req.user is populated. The route handler is subscribed INSIDE
 * auditContext.run(), so the handler and its awaited service calls inherit the store.
 */
@Injectable()
export class AuditContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "http") return next.handle();
    const user = ctx.switchToHttp().getRequest()?.user;
    if (!user) return next.handle(); // public route — no auth context to record
    const store: AuditCtx = user.tokenId ? { via: "pat", tokenId: user.tokenId } : { via: "session" };
    return new Observable((subscriber) => auditContext.run(store, () => next.handle().subscribe(subscriber)));
  }
}

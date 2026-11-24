import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { isPortalRoute, portalContext } from "./portal-surface";

/**
 * Tells TeamAccessService whether the request is on the customer-portal surface (see portal-surface.ts), for the whole
 * lifetime of the handler. Registered globally; the route handler is subscribed INSIDE portalContext.run() so the
 * handler and everything it awaits inherit the store (same pattern as AuditContextInterceptor).
 */
@Injectable()
export class PortalSurfaceInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "http") return next.handle();
    const req = ctx.switchToHttp().getRequest();
    const surface = isPortalRoute(req?.method, req?.path ?? req?.url ?? "");
    return new Observable((subscriber) => portalContext.run({ surface }, () => next.handle().subscribe(subscriber)));
  }
}

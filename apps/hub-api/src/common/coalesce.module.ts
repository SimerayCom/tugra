import { CallHandler, ExecutionContext, Global, Injectable, Module, NestInterceptor } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { tap, type Observable } from "rxjs";
import { ReadCoalescer } from "./read-coalescer";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Any HTTP write drops the coalesced read snapshots before AND right after the handler, so the panel's refetch that
 *  follows its own mutation never sees the pre-mutation list (see ReadCoalescer). */
@Injectable()
export class CoalesceInvalidateInterceptor implements NestInterceptor {
  constructor(private readonly coalescer: ReadCoalescer) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "http") return next.handle();
    const method = String(ctx.switchToHttp().getRequest()?.method ?? "GET").toUpperCase();
    if (SAFE.has(method)) return next.handle();
    this.coalescer.invalidate();
    return next.handle().pipe(tap({ next: () => this.coalescer.invalidate(), error: () => this.coalescer.invalidate() }));
  }
}

@Global()
@Module({
  providers: [{ provide: ReadCoalescer, useFactory: () => new ReadCoalescer() }, { provide: APP_INTERCEPTOR, useClass: CoalesceInvalidateInterceptor }],
  exports: [ReadCoalescer],
})
export class CoalesceModule {}

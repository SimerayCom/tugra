import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ContainerOpsService } from "./container-ops.service";

/**
 * Authorizes the server container-log SSE endpoint BEFORE the stream starts. `@Sse` commits a 200 +
 * text/event-stream as soon as the handler runs, so a throw inside it can no longer set 403/400/503.
 * This guard runs first and its exception becomes the real HTTP status — like the app/database guards.
 */
@Injectable()
export class ContainerLogStreamGuard implements CanActivate {
  constructor(private readonly containerOps: ContainerOpsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ user?: { userId: string }; params: { id: string }; query: { container?: string } }>();
    await this.containerOps.assertLogAccess(req.user!.userId, req.params.id, req.query.container ?? "");
    return true;
  }
}

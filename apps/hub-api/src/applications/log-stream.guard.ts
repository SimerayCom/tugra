import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ApplicationsService } from "./applications.service";

/**
 * Authorizes the container-log SSE endpoint BEFORE the stream starts. `@Sse` commits a 200 +
 * text/event-stream response as soon as the route handler runs, so throwing from inside the handler
 * can no longer set 403/503. This guard runs first (canActivate), and its ForbiddenException /
 * ServiceUnavailableException becomes the real HTTP status — mirroring how the plain `@Get` endpoints
 * (e.g. /metrics/containers) already behave.
 */
@Injectable()
export class ContainerLogStreamGuard implements CanActivate {
  constructor(private readonly apps: ApplicationsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ user?: { userId: string }; params: { id: string } }>();
    await this.apps.assertContainerLogStreamAccess(req.user!.userId, req.params.id);
    return true;
  }
}

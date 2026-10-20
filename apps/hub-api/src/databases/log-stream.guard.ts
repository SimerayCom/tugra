import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { DatabasesService } from "./databases.service";

/**
 * Authorizes the database-log SSE endpoint BEFORE the stream starts. `@Sse` commits a 200 +
 * text/event-stream response as soon as the route handler runs, so throwing from inside the handler
 * can no longer set 403/503. This guard runs first (canActivate), and its ForbiddenException /
 * ServiceUnavailableException becomes the real HTTP status — mirroring the applications log guard.
 */
@Injectable()
export class DatabaseLogStreamGuard implements CanActivate {
  constructor(private readonly databases: DatabasesService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ user?: { userId: string }; params: { id: string } }>();
    await this.databases.assertLogStreamAccess(req.user!.userId, req.params.id);
    return true;
  }
}

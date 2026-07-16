import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { REQUIRE_SCOPES } from "./require-scopes.decorator";
import { methodDefaultScope, scopeSatisfies, type Scope } from "./scopes";

/**
 * Enforce API-token scopes. MUST run AFTER ApiAuthGuard (`@UseGuards(ApiAuthGuard, ScopesGuard)`), which
 * populates `req.user.scopes` — a browser session gets `["*"]` (full), a PAT gets its granted scopes.
 * The required scope comes from `@RequireScopes(...)` or, by default, from the HTTP method (fail-safe:
 * mutating routes default to `write`). Not a global guard: global guards run before ApiAuthGuard, so
 * `req.user` wouldn't exist yet.
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== "http") return true; // WS handles its own auth
    const req = ctx.switchToHttp().getRequest();
    const scopes: string[] | undefined = req.user?.scopes;
    if (!scopes) throw new ForbiddenException("token has no scopes"); // fail-closed (shouldn't happen)
    const required: Scope[] =
      this.reflector.getAllAndOverride<Scope[]>(REQUIRE_SCOPES, [ctx.getHandler(), ctx.getClass()]) ??
      [methodDefaultScope(String(req.method))];
    if (!required.every((r) => scopeSatisfies(scopes, r))) {
      throw new ForbiddenException("insufficient token scope");
    }
    return true;
  }
}

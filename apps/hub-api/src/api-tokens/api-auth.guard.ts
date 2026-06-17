import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { ApiTokensService } from "./api-tokens.service";
import { isApiToken } from "./api-token.util";

/**
 * Accepts either a session JWT (delegates to JwtAuthGuard) or a personal access
 * token (`tugra_pat_…`). A superset of JwtAuthGuard, so existing JWT callers are
 * unaffected.
 */
@Injectable()
export class ApiAuthGuard extends JwtAuthGuard {
  constructor(private readonly tokens: ApiTokensService) {
    super();
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth: string | undefined = req.headers?.authorization;
    const raw = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (isApiToken(raw)) {
      const user = await this.tokens.validate(raw);
      if (!user) throw new UnauthorizedException("invalid or expired api token");
      req.user = user;
      return true;
    }
    return (await super.canActivate(ctx)) as boolean;
  }
}

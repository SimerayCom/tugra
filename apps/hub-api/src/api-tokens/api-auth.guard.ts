import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { observedIp } from "../common/observed-ip";
import { ipMatchesAllowlist } from "../common/ip-allowlist";
import { ApiTokensService } from "./api-tokens.service";
import { isApiToken } from "./api-token.util";

/**
 * Accepts either a session JWT (delegates to JwtAuthGuard) or a personal access
 * token (`tugra_pat_…`). A superset of JwtAuthGuard, so existing JWT callers are
 * unaffected. Instance-level API gating (kill-switch + IP allowlist) is enforced
 * HERE in the PAT branch only — browser/JWT sessions are never gated.
 */
@Injectable()
export class ApiAuthGuard extends JwtAuthGuard {
  constructor(
    private readonly tokens: ApiTokensService,
    private readonly instance: InstanceSettingsService,
  ) {
    super();
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth: string | undefined = req.headers?.authorization;
    const raw = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (isApiToken(raw)) {
      const user = await this.tokens.validate(raw);
      if (!user) throw new UnauthorizedException("invalid or expired api token");
      // PAT-only gating: a killed API or an off-allowlist source blocks the token, never the web session
      // (which takes the branch below). get() is read-only in steady state, so this is per-request safe.
      const settings = await this.instance.get();
      if (!settings.apiEnabled) throw new ForbiddenException("api access is disabled");
      if (settings.apiAllowedIps.length > 0) {
        const fwd = req.headers?.["x-forwarded-for"];
        const ip = observedIp(
          req.socket?.remoteAddress,
          Array.isArray(fwd) ? fwd[0] : fwd,
          process.env.HUB_TRUSTED_PROXY === "true",
        );
        if (!ip || !ipMatchesAllowlist(ip, settings.apiAllowedIps)) {
          throw new ForbiddenException("api access from this address is not allowed");
        }
      }
      req.user = user;
      return true;
    }
    return (await super.canActivate(ctx)) as boolean;
  }
}

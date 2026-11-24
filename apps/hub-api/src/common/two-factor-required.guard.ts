import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ALLOW_UNVERIFIED } from "./allow-unverified.decorator";
import { parseCookies, TG_ACCESS } from "./cookies";
import { TwoFactorPolicyService } from "../auth/two-factor-policy.service";

/** Public bootstrap reads the web shell makes before/while it shows the 2FA setup screen. */
const PUBLIC_PATHS = new Set(["/instance/status", "/instance/branding", "/instance/version", "/health", "/version"]);

/**
 * Enforces the instance policy "Require 2FA for owners/admins". When it is on, an owner/admin who has not enrolled
 * two-factor can only reach the account self-service routes (the same @AllowUnverified set: /auth/me, /auth/2fa/*,
 * logout …) and the public bootstrap reads, so they can ALWAYS enrol and are never locked out. Everything else
 * answers 403 `two_factor_required`, which the web turns into the setup screen. Like EmailVerifiedGuard it is an
 * ADDITIONAL gate resolved from the access token itself (a global guard runs before JwtAuthGuard); a missing,
 * forged or expired token falls through to the route's own guard, and PAT / agent credentials are not user
 * sessions so they are unaffected. With the policy off the flag is served from a short in-memory cache (TwoFactorPolicyService), so it adds no query.
 */
@Injectable()
export class TwoFactorRequiredGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly policy: TwoFactorPolicyService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== "http") return true;
    const req = ctx.switchToHttp().getRequest();
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_UNVERIFIED, [ctx.getHandler(), ctx.getClass()])) return true;
    // Routes are served under the global `/api/v1` prefix (a few probes are exempt and stay bare) → strip it first.
    const path = String(req.path ?? req.url ?? "").split("?")[0].replace(/\/+$/, "").replace(/^\/api\/v1(?=\/|$)/, "");
    if (PUBLIC_PATHS.has(path)) return true;
    const userId = await this.resolveUserId(req);
    if (!userId) return true; // public route / PAT / bad token → the route's own guard decides
    if (await this.policy.setupRequired(userId)) {
      throw new ForbiddenException({ statusCode: 403, message: "two-factor authentication is required for owners and admins", code: "two_factor_required" });
    }
    return true;
  }

  private async resolveUserId(req: { headers?: { authorization?: string; cookie?: string | string[] } }): Promise<string | null> {
    const authz = req.headers?.authorization;
    const bearer = typeof authz === "string" && authz.startsWith("Bearer ") ? authz.slice(7) : null;
    const token = bearer ?? parseCookies(req.headers?.cookie)[TG_ACCESS];
    if (!token) return null;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; type?: string }>(token, {
        secret: this.config.get<string>("JWT_ACCESS_SECRET"),
      });
      return payload.type === "access" ? payload.sub : null;
    } catch {
      return null;
    }
  }
}

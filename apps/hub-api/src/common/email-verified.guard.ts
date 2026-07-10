import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ALLOW_UNVERIFIED } from "./allow-unverified.decorator";
import { parseCookies, TG_ACCESS } from "./cookies";
import { PrismaService } from "../prisma/prisma.service";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * When REQUIRE_EMAIL_VERIFICATION is on, blocks unverified users from state-changing requests
 * (self-host opt-in; off by default → this guard returns immediately with zero cost). Global guards
 * run before the route's JwtAuthGuard, so req.user isn't populated yet — the guard resolves the
 * userId itself from the Bearer header or the tg_access cookie. It's an ADDITIONAL gate, not the auth
 * boundary: an unresolvable/forged/expired token is allowed through here and rejected downstream by
 * JwtAuthGuard (401). Reads are always allowed (so an unverified user can see the "verify" state),
 * and @AllowUnverified routes (account self-service) are exempt.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.config.get<string>("REQUIRE_EMAIL_VERIFICATION") !== "true") return true; // opt-in, off by default
    if (ctx.getType() !== "http") return true;
    const req = ctx.switchToHttp().getRequest();
    if (!MUTATING.has(String(req.method ?? "GET").toUpperCase())) return true; // reads are safe
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_UNVERIFIED, [ctx.getHandler(), ctx.getClass()])) {
      return true; // account self-service (verify/resend/logout/profile/2fa)
    }
    const userId = await this.resolveUserId(req);
    if (!userId) return true; // public route or bad token → let the route's own guard decide
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { emailVerified: true } });
    if (user && !user.emailVerified) {
      throw new ForbiddenException("email not verified");
    }
    return true;
  }

  /** Resolve the caller's userId from a Bearer access JWT or the tg_access cookie (verified). */
  private async resolveUserId(req: {
    headers?: { authorization?: string; cookie?: string | string[] };
  }): Promise<string | null> {
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
      return null; // expired/forged → not our concern here (JwtAuthGuard rejects it downstream)
    }
  }
}

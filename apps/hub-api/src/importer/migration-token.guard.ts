import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { isMigrationToken } from "./migration-token";
import { MigrationTokenService } from "./migration-token.service";

/**
 * Authenticates a request from the SOURCE host by a one-time migration token in `Authorization: Bearer
 * tugra_mig_…`. Modelled on ApiAuthGuard (header extract → hash-lookup via a service.validate()), but it
 * carries no user: it resolves the opId from the token ALONE and attaches it to the request, so a handler
 * behind this guard must take the opId only from `@MigrationOp()` — never from a param/body/query (the
 * untrusted host never names the destination). Every failure (missing/malformed/unknown/expired/revoked/
 * cancelled) shares one 401 message so the token is not an existence oracle.
 */
@Injectable()
export class MigrationTokenGuard implements CanActivate {
  constructor(private readonly tokens: MigrationTokenService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth: unknown = req.headers?.authorization;
    const raw = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    // Reject a wrong-format value before any DB hit (and bound the hashed input).
    if (!isMigrationToken(raw)) throw new UnauthorizedException("invalid or expired migration token");
    const ctxv = await this.tokens.validate(raw);
    if (!ctxv) throw new UnauthorizedException("invalid or expired migration token");
    req.migration = ctxv;
    return true;
  }
}

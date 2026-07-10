import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { parseCookies, TG_ACCESS } from "../../common/cookies";

export interface AccessTokenPayload {
  sub: string;
  type: "access";
}

export interface AuthUser {
  userId: string;
}

/** Minimal request shape we read — avoids a hard @types/express dependency. */
interface CookieRequest {
  headers?: { cookie?: string | string[] };
}

/** Pull the access JWT from the httpOnly cookie (browser sessions). */
function fromAccessCookie(req: CookieRequest): string | null {
  return parseCookies(req.headers?.cookie)[TG_ACCESS] ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      // Accept the Bearer header (PAT / CLI / API clients) OR the httpOnly cookie (browser). The
      // header is tried first so an explicit bearer always wins.
      jwtFromRequest: ExtractJwt.fromExtractors([ExtractJwt.fromAuthHeaderAsBearerToken(), fromAccessCookie]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>("JWT_ACCESS_SECRET")!,
    });
  }

  validate(payload: AccessTokenPayload): AuthUser {
    if (payload.type !== "access") {
      throw new UnauthorizedException("invalid token type");
    }
    return { userId: payload.sub };
  }
}

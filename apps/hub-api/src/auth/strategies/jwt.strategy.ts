import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

export interface AccessTokenPayload {
  sub: string;
  type: "access";
}

export interface AuthUser {
  userId: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
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

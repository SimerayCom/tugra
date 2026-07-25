import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { CryptoModule } from "../crypto/crypto.module";
import { TeamDefaultsModule } from "../teams/team-defaults.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { GithubOAuthController } from "./github-oauth.controller";
import { GithubOAuthService } from "./github-oauth.service";
import { OidcController } from "./oidc.controller";
import { OidcService } from "./oidc.service";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { TotpService } from "./totp.service";

@Module({
  imports: [PassportModule, JwtModule.register({}), CryptoModule, TeamDefaultsModule],
  controllers: [AuthController, GithubOAuthController, OidcController],
  providers: [AuthService, GithubOAuthService, OidcService, TotpService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}

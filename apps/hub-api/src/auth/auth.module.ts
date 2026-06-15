import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { CryptoModule } from "../crypto/crypto.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { RolesGuard } from "./guards/roles.guard";
import { TotpService } from "./totp.service";

@Module({
  imports: [PassportModule, JwtModule.register({}), CryptoModule],
  controllers: [AuthController],
  providers: [AuthService, TotpService, JwtStrategy, RolesGuard],
  exports: [AuthService],
})
export class AuthModule {}

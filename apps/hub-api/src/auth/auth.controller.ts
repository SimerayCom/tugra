import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AuthService } from "./auth.service";
import { CurrentUser } from "./decorators/current-user.decorator";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { AuthUser } from "./strategies/jwt.strategy";
import {
  ChangePasswordInput,
  ChangePasswordSchema,
  Enable2faInput,
  Enable2faSchema,
  LoginInput,
  LoginSchema,
  RefreshInput,
  RefreshSchema,
  RegisterInput,
  RegisterSchema,
  UpdateProfileInput,
  UpdateProfileSchema,
} from "./dto/auth.schemas";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  register(@Body(new ZodValidationPipe(RegisterSchema)) body: RegisterInput) {
    return this.auth.register(body.email, body.password, body.name);
  }

  @Post("login")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body(new ZodValidationPipe(LoginSchema)) body: LoginInput) {
    return this.auth.login(body.email, body.password, body.totp);
  }

  @Post("refresh")
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  refresh(@Body(new ZodValidationPipe(RefreshSchema)) body: RefreshInput) {
    return this.auth.refresh(body.refreshToken);
  }

  @Post("logout")
  @HttpCode(200)
  async logout(@Body(new ZodValidationPipe(RefreshSchema)) body: RefreshInput) {
    await this.auth.logout(body.refreshToken);
    return { ok: true };
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.userId);
  }

  @Patch("me")
  @UseGuards(JwtAuthGuard)
  updateProfile(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) body: UpdateProfileInput,
  ) {
    return this.auth.updateProfile(user.userId, body);
  }

  @Post("change-password")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ChangePasswordSchema)) body: ChangePasswordInput,
  ) {
    await this.auth.changePassword(user.userId, body.currentPassword, body.newPassword);
    return { ok: true };
  }

  @Post("2fa/setup")
  @UseGuards(JwtAuthGuard)
  setup2fa(@CurrentUser() user: AuthUser) {
    return this.auth.setup2FA(user.userId);
  }

  @Post("2fa/enable")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async enable2fa(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(Enable2faSchema)) body: Enable2faInput,
  ) {
    // Returns the plaintext recovery codes ONCE — the client must show + let the user save them.
    return this.auth.enable2FA(user.userId, body.token);
  }
}

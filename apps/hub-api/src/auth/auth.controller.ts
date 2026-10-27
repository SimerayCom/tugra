import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  CookieResponse,
  clearAuthCookies,
  parseCookies,
  setAuthCookies,
  TG_CSRF,
  TG_REFRESH,
} from "../common/cookies";
import { CsrfExempt } from "../common/csrf-exempt.decorator";
import { publicUrlFrom, type ReqLike } from "../common/hub-url";
import { AllowUnverified } from "../common/allow-unverified.decorator";
import { AuthService } from "./auth.service";
import { CurrentUser } from "./decorators/current-user.decorator";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { AuthUser } from "./strategies/jwt.strategy";
import {
  ChangePasswordInput,
  ChangePasswordSchema,
  Enable2faInput,
  Enable2faSchema,
  ForgotPasswordInput,
  ForgotPasswordSchema,
  LoginInput,
  LoginSchema,
  ResetPasswordInput,
  ResetPasswordSchema,
  RefreshInput,
  RefreshSchema,
  RegisterInput,
  RegisterSchema,
  TwoFaSudoInput,
  TwoFaSudoSchema,
  UpdateProfileInput,
  UpdateProfileSchema,
  VerifyEmailInput,
  VerifyEmailSchema,
} from "./dto/auth.schemas";

/** Minimal request shape we read for cookies — avoids a hard @types/express dependency. */
interface CookieRequest {
  headers?: { cookie?: string | string[] };
}

@ApiTags("auth")
@Controller("auth")
@AllowUnverified() // every auth self-service route stays reachable for unverified users
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  @CsrfExempt()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiZodBody(RegisterSchema)
  async register(
    @Body(new ZodValidationPipe(RegisterSchema)) body: RegisterInput,
    @Res({ passthrough: true }) res: CookieResponse,
    @Req() req: ReqLike,
  ) {
    // Dual-mode: also set httpOnly session cookies for the browser, while keeping `tokens` in the
    // body so PAT/CLI/e2e bearer clients are unaffected. The request's public host pins the single-box
    // server's reachable IP at first-owner claim (no outbound probe) so deployed-app URLs resolve at once.
    const result = await this.auth.register(body.email, body.password, body.name, body.setupCode, publicUrlFrom(req));
    setAuthCookies(res, result.tokens);
    return result;
  }

  @Post("login")
  @HttpCode(200)
  @CsrfExempt()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiZodBody(LoginSchema)
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) body: LoginInput,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    const result = await this.auth.login(body.email, body.password, body.totp);
    if ("tokens" in result) setAuthCookies(res, result.tokens); // no cookies on the 2FA-required step
    return result;
  }

  @Post("forgot-password")
  @HttpCode(200)
  @CsrfExempt()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiZodBody(ForgotPasswordSchema)
  async forgotPassword(@Body(new ZodValidationPipe(ForgotPasswordSchema)) body: ForgotPasswordInput) {
    // Always 200 whether or not the email exists — no account enumeration.
    await this.auth.requestPasswordReset(body.email);
    return { ok: true };
  }

  @Post("reset-password")
  @HttpCode(200)
  @CsrfExempt()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiZodBody(ResetPasswordSchema)
  async resetPassword(@Body(new ZodValidationPipe(ResetPasswordSchema)) body: ResetPasswordInput) {
    await this.auth.resetPassword(body.token, body.newPassword);
    return { ok: true };
  }

  @Post("verify-email")
  @HttpCode(200)
  @CsrfExempt()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiZodBody(VerifyEmailSchema)
  async verifyEmail(@Body(new ZodValidationPipe(VerifyEmailSchema)) body: VerifyEmailInput) {
    // Public: the token IS the authorization (clicked from an email, possibly on another device).
    await this.auth.verifyEmail(body.token);
    return { ok: true };
  }

  @Post("resend-verification")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async resendVerification(@CurrentUser() user: AuthUser) {
    // Authenticated (no enumeration surface) — re-sends for the current user, no-op if verified.
    await this.auth.resendVerification(user.userId);
    return { ok: true };
  }

  @Post("refresh")
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiZodBody(RefreshSchema)
  async refresh(
    @Req() req: CookieRequest,
    @Body(new ZodValidationPipe(RefreshSchema)) body: RefreshInput,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    const cookies = parseCookies(req.headers?.cookie);
    // Browser sessions carry the refresh token in the cookie; body clients still send it inline.
    const token = cookies[TG_REFRESH] ?? body.refreshToken;
    if (!token) throw new UnauthorizedException("missing refresh token");
    const tokens = await this.auth.refresh(token);
    // Preserve the existing CSRF value so a background refresh doesn't rotate the double-submit
    // token out from under concurrent in-flight requests.
    setAuthCookies(res, tokens, { csrf: cookies[TG_CSRF] });
    return tokens;
  }

  @Post("logout")
  @HttpCode(200)
  @ApiZodBody(RefreshSchema)
  async logout(
    @Req() req: CookieRequest,
    @Body(new ZodValidationPipe(RefreshSchema)) body: RefreshInput,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    const token = parseCookies(req.headers?.cookie)[TG_REFRESH] ?? body.refreshToken;
    if (token) await this.auth.logout(token);
    clearAuthCookies(res);
    return { ok: true };
  }

  @Post("logout-all")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async logoutAll(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: CookieResponse) {
    await this.auth.logoutAll(user.userId);
    clearAuthCookies(res);
    return { ok: true };
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.userId);
  }

  @Patch("me")
  @UseGuards(JwtAuthGuard)
  @ApiZodBody(UpdateProfileSchema)
  updateProfile(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) body: UpdateProfileInput,
  ) {
    return this.auth.updateProfile(user.userId, body);
  }

  @Post("change-password")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiZodBody(ChangePasswordSchema)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Req() req: CookieRequest,
    @Body(new ZodValidationPipe(ChangePasswordSchema)) body: ChangePasswordInput,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    // Returns fresh tokens for THIS device (all other sessions were revoked) — the client swaps
    // them in so the current session survives the password change seamlessly.
    const tokens = await this.auth.changePassword(user.userId, body.currentPassword, body.newPassword);
    // Refresh the cookies too (preserving CSRF), so a cookie session survives the password change.
    setAuthCookies(res, tokens, { csrf: parseCookies(req.headers?.cookie)[TG_CSRF] });
    return { ok: true, tokens };
  }

  @Post("2fa/setup")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  setup2fa(@CurrentUser() user: AuthUser) {
    return this.auth.setup2FA(user.userId);
  }

  @Post("2fa/enable")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiZodBody(Enable2faSchema)
  async enable2fa(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(Enable2faSchema)) body: Enable2faInput,
  ) {
    // Returns the plaintext recovery codes ONCE — the client must show + let the user save them.
    return this.auth.enable2FA(user.userId, body.token);
  }

  @Post("2fa/disable")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiZodBody(TwoFaSudoSchema)
  async disable2fa(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(TwoFaSudoSchema)) body: TwoFaSudoInput,
  ) {
    await this.auth.disable2FA(user.userId, body.password, body.code);
    return { ok: true };
  }

  @Post("2fa/recovery-codes/regenerate")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiZodBody(TwoFaSudoSchema)
  async regenerateRecoveryCodes(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(TwoFaSudoSchema)) body: TwoFaSudoInput,
  ) {
    // Returns the fresh plaintext recovery codes ONCE.
    return this.auth.regenerateRecoveryCodes(user.userId, body.password, body.code);
  }

  @Get("2fa/recovery-codes/status")
  @UseGuards(JwtAuthGuard)
  recoveryCodesStatus(@CurrentUser() user: AuthUser) {
    return this.auth.recoveryCodesStatus(user.userId);
  }
}

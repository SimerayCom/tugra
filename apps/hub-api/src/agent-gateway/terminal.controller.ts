import { Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import type { AuthUser } from "../auth/strategies/jwt.strategy";

/**
 * Mints a short-lived terminal ticket. A browser session's access token lives in an httpOnly
 * cookie that JS can't read, so it can't be placed in the WebSocket subprotocol. Instead the SPA
 * calls this (cookie-authenticated) endpoint to get a 60-second, single-purpose `term_ticket` JWT
 * it CAN read, and passes that in the `tugra.bearer` subprotocol when opening /terminal.
 */
@Controller("terminal")
export class TerminalController {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  @Post("ticket")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async ticket(@CurrentUser() user: AuthUser): Promise<{ ticket: string }> {
    const ticket = await this.jwt.signAsync(
      { sub: user.userId, type: "term_ticket" },
      { secret: this.config.get<string>("JWT_ACCESS_SECRET"), expiresIn: "60s" },
    );
    return { ticket };
  }
}

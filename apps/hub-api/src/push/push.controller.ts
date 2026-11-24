import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { PushService } from "./push.service";
import { SubscribePushInput, SubscribePushSchema, TestPushInput, TestPushSchema } from "./dto";

/**
 * Web Push devices of the signed-in user. Personal and session-only (like api-tokens): every route is scoped to the
 * caller's own subscriptions (no team permission applies; a push CHANNEL, which targets a team's events, is managed through
 * /channels and needs the `integrations` permission).
 */
@ApiTags("push")
@ApiCookieAuth("session")
@Controller("push")
@UseGuards(JwtAuthGuard) // a device is registered from a signed-in browser; a leaked API token must not be able to add one
export class PushController {
  constructor(private readonly push: PushService) {}

  /** The VAPID public key the browser subscribes with (`applicationServerKey`). */
  @Get("public-key")
  async publicKey() {
    return { publicKey: await this.push.publicKey() };
  }

  @Get("devices")
  devices(@CurrentUser() user: AuthUser) {
    return this.push.list(user.userId);
  }

  @Post("devices")
  @ApiZodBody(SubscribePushSchema)
  subscribe(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(SubscribePushSchema)) body: SubscribePushInput) {
    return this.push.subscribe(user.userId, body);
  }

  @Delete("devices/:id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.push.unsubscribe(user.userId, id);
    return { ok: true };
  }

  /** Send a test notification to all of the caller's devices. */
  @Post("test")
  @HttpCode(200)
  @ApiZodBody(TestPushSchema)
  test(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(TestPushSchema)) body: TestPushInput) {
    return this.push.test(user.userId, {
      title: body.title ?? "Tugra",
      body: body.body ?? "Push notifications are on.",
      url: "/",
      tag: "test",
      level: "info",
    });
  }
}

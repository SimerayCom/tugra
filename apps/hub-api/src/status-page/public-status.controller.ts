import { Body, Controller, Get, Header, HttpCode, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CsrfExempt } from "../common/csrf-exempt.decorator";
import { StatusPageService } from "./status-page.service";
import { StatusSubscribersService } from "./status-subscribers.service";
import { SubscribeInput, SubscribeSchema, SubscriberTokenInput, SubscriberTokenSchema } from "./dto";

/**
 * PUBLIC (unauthenticated) status page of a team: the chosen monitors' names and states, incident history and
 * maintenance notices — see StatusPageService.publicView for exactly what leaves the hub. Separate from the
 * management controller because that one is class-guarded by ApiAuthGuard. Reads are throttled (and cached); the
 * subscription POSTs are CSRF-exempt (body-authenticated, no session) and throttled harder.
 */
@ApiTags("status-page")
@Controller("public/status")
export class PublicStatusController {
  constructor(
    private readonly pages: StatusPageService,
    private readonly subscribers: StatusSubscribersService,
  ) {}

  // Static segments first so "subscribers" is never read as a slug.
  @Post("subscribers/confirm")
  @HttpCode(200)
  @CsrfExempt()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  confirm(@Body(new ZodValidationPipe(SubscriberTokenSchema)) body: SubscriberTokenInput) {
    return this.subscribers.confirm(body.token);
  }

  @Post("subscribers/unsubscribe")
  @HttpCode(200)
  @CsrfExempt()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  unsubscribe(@Body(new ZodValidationPipe(SubscriberTokenSchema)) body: SubscriberTokenInput) {
    return this.subscribers.unsubscribe(body.token);
  }

  @Get(":slug")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Header("Cache-Control", "public, max-age=30")
  view(@Param("slug") slug: string) {
    return this.pages.publicView(slug);
  }

  @Get(":slug/rss")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header("Content-Type", "application/rss+xml; charset=utf-8")
  @Header("Cache-Control", "public, max-age=60")
  rss(@Param("slug") slug: string) {
    return this.pages.rss(slug);
  }

  @Post(":slug/subscribe")
  @HttpCode(200)
  @CsrfExempt()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async subscribe(@Param("slug") slug: string, @Body(new ZodValidationPipe(SubscribeSchema)) body: SubscribeInput) {
    await this.subscribers.subscribe(slug, body.email);
    return { ok: true };
  }
}

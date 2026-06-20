import { Controller, HttpCode, Param, Post, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { WebhooksService } from "./webhooks.service";

interface WebhookRequest {
  rawBody?: Buffer;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Public (unauthenticated) git webhook receiver. Authorization is the per-app
 * webhook secret (HMAC for GitHub, token header for GitLab), verified in the
 * service. Throttled to blunt brute-force attempts against the token.
 */
@Controller("webhooks")
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post("deploy/:token")
  @HttpCode(202)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  deploy(@Param("token") token: string, @Req() req: WebhookRequest) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    return this.webhooks.handle(token, req.headers, rawBody);
  }
}

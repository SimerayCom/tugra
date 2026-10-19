import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { MailDnsService } from "./mail-dns.service";
import { MailDnsRequestInput, MailDnsRequestSchema } from "./dto";

/** One-click mail-deliverability DNS (MX/SPF/DMARC/DKIM) via a team Cloudflare credential. Behind
 *  ApiAuthGuard+ScopesGuard (both a browser session and a PAT can drive it); the service additionally enforces
 *  the `integrations` team permission on the credential's team. `/preview` is a side-effect-free dry run,
 *  `/apply` creates the records and refuses to clobber a domain that already receives mail unless `overwrite`. */
@ApiTags("dns-mail")
@ApiSecurity("pat")
@Controller("dns/mail")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class MailDnsController {
  constructor(private readonly svc: MailDnsService) {}

  @Post("preview")
  @HttpCode(200)
  @ApiZodBody(MailDnsRequestSchema)
  preview(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(MailDnsRequestSchema)) body: MailDnsRequestInput) {
    return this.svc.previewMailRecords(user.userId, body);
  }

  @Post("apply")
  @HttpCode(200)
  @ApiZodBody(MailDnsRequestSchema)
  apply(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(MailDnsRequestSchema)) body: MailDnsRequestInput) {
    return this.svc.applyMailRecords(user.userId, body);
  }
}

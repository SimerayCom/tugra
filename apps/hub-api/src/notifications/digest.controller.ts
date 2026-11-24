import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { DigestService } from "./digest.service";
import { UpdateDigestInput, UpdateDigestSchema } from "./dto";

/** The weekly team digest setting (opt-in, one chosen channel per team). */
@ApiTags("channels")
@ApiSecurity("pat")
@Controller("teams/:teamId/digest")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class DigestController {
  constructor(private readonly svc: DigestService) {}

  @Get()
  get(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string) {
    return this.svc.get(user.userId, teamId);
  }

  @Put()
  @HttpCode(200)
  @ApiZodBody(UpdateDigestSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("teamId") teamId: string,
    @Body(new ZodValidationPipe(UpdateDigestSchema)) body: UpdateDigestInput,
  ) {
    return this.svc.update(user.userId, teamId, body);
  }

  /** Send this week's digest to the chosen channel right now (does not change the Monday schedule). */
  @Post("send")
  @HttpCode(200)
  async send(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string) {
    await this.svc.sendNow(user.userId, teamId);
    return { ok: true };
  }
}

import { Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiCookieAuth } from "@nestjs/swagger";
import { ApiZodResponse } from "../openapi/openapi";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { InstanceOwnerGuard } from "../instance/instance-owner.guard";
import { PanelTlsService, PanelTlsStatusSchema } from "./panel-tls.service";

/**
 * Owner-only control-panel HTTPS (DİLİM 1). Session-based (JwtAuthGuard, not the API token) like the other
 * instance-owner routes, so a PAT can't reach it. No edition gate — panel TLS is community-free.
 */
@ApiTags("instance")
@ApiCookieAuth("session")
@Controller("instance/panel-tls")
@UseGuards(JwtAuthGuard, InstanceOwnerGuard)
export class PanelTlsController {
  constructor(private readonly panelTls: PanelTlsService) {}

  @Get()
  @ApiZodResponse(PanelTlsStatusSchema)
  status() {
    return this.panelTls.status();
  }

  @Post("apply")
  @HttpCode(200)
  @ApiZodResponse(PanelTlsStatusSchema)
  apply(@CurrentUser() user: AuthUser) {
    return this.panelTls.apply(user.userId);
  }
}

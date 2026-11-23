import { Body, Controller, Get, Header, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiCookieAuth } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { InstanceOwnerGuard } from "../instance/instance-owner.guard";
import { PanelDomainService } from "./panel-domain.service";
import {
  PanelDomainStatusSchema,
  RemovePanelDomainSchema,
  SetPanelDomainSchema,
  type RemovePanelDomainInput,
  type SetPanelDomainInput,
} from "./panel-domain.dto";

/**
 * Owner-only panel domain (Settings → Instance → Panel domain). Session-based (JwtAuthGuard, not the API token) like
 * the other instance-owner routes, so a PAT can't reach it. POSTs honor the global `Idempotency-Key` replay, and are
 * naturally idempotent too (the host already served, or the same change already running, returns the status).
 * The change itself runs in the background; poll GET for progress / the rollback reason.
 */
@ApiTags("instance")
@ApiCookieAuth("session")
@Controller("instance/panel-domain")
@UseGuards(JwtAuthGuard, InstanceOwnerGuard)
export class PanelDomainController {
  constructor(private readonly panelDomain: PanelDomainService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @ApiZodResponse(PanelDomainStatusSchema)
  status() {
    return this.panelDomain.status();
  }

  /** Serve the panel on a domain (Let's Encrypt HTTP-01, no Cloudflare token). 202: the change runs in the background. */
  @Post()
  @HttpCode(202)
  @ApiZodBody(SetPanelDomainSchema)
  @ApiZodResponse(PanelDomainStatusSchema)
  set(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(SetPanelDomainSchema)) body: SetPanelDomainInput) {
    return this.panelDomain.set(user.userId, body);
  }

  /** Stop waiting for the agents that have not moved to the new address yet: the old address stops being routed for them now. */
  @Post("agents/release")
  @HttpCode(200)
  @ApiZodResponse(PanelDomainStatusSchema)
  releaseAgents(@CurrentUser() user: AuthUser) {
    return this.panelDomain.releaseAgents(user.userId);
  }

  /** Drop the domain and go back to http://<server-ip>/. 202: the change runs in the background. */
  @Post("remove")
  @HttpCode(202)
  @ApiZodBody(RemovePanelDomainSchema)
  @ApiZodResponse(PanelDomainStatusSchema)
  remove(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(RemovePanelDomainSchema)) body: RemovePanelDomainInput) {
    return this.panelDomain.remove(user.userId, body);
  }
}

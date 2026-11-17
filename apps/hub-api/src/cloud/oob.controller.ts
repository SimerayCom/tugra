import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { SkipIdempotency } from "../common/skip-idempotency.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { OobService } from "./oob.service";
import {
  OobActionResultSchema,
  OobCandidatesSchema,
  OobConsoleResultSchema,
  OobLinkInput,
  OobLinkSchema,
  OobPowerInput,
  OobPowerSchema,
  OobRescueResultSchema,
  OobStatusSchema,
} from "./oob.dto";

/**
 * Out-of-band access to a cloud-linked server (power, rescue, provider console), usable while its agent is offline.
 * Team permission `servers:ops` (linking: `servers:manage`) + PAT scope `deploy`; the two routes that return a
 * secret (rescue password, console session) also need `read:secrets` and are never cacheable and never stored for `Idempotency-Key` replay.
 */
@ApiTags("servers")
@ApiSecurity("pat")
@Controller("servers/:id/oob")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class OobController {
  constructor(private readonly oob: OobService) {}

  /** The cloud link and the provider-side state (power, rescue). Any member of the server's team. */
  @Get()
  @ApiZodResponse(OobStatusSchema)
  status(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.oob.status(user.userId, id);
  }

  /** power_on | power_off | reboot (hard reset) | shutdown. The last three need `confirmName` = the server's name. */
  @Post("power")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(OobPowerSchema)
  @ApiZodResponse(OobActionResultSchema)
  power(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(OobPowerSchema)) body: OobPowerInput) {
    return this.oob.power(user.userId, id, body);
  }

  /** Enable the rescue system; the one-time root password is in this response only. */
  @Post("rescue")
  @RequireScopes("deploy", "read:secrets")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @SkipIdempotency()
  @ApiZodResponse(OobRescueResultSchema)
  enableRescue(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.oob.enableRescue(user.userId, id);
  }

  @Delete("rescue")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(OobActionResultSchema)
  disableRescue(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.oob.disableRescue(user.userId, id);
  }

  /** Request a console session; the websocket URL and VNC password are in this response only (valid ~1 minute). */
  @Post("console")
  @RequireScopes("deploy", "read:secrets")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @SkipIdempotency()
  @ApiZodResponse(OobConsoleResultSchema)
  console(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.oob.console(user.userId, id);
  }

  /** The cloud servers a credential can see, to pick the one this server runs on. */
  @Get("candidates")
  @RequireScopes("deploy")
  @ApiZodResponse(OobCandidatesSchema)
  candidates(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query("cloudCredentialId") cloudCredentialId: string) {
    return this.oob.candidates(user.userId, id, cloudCredentialId ?? "");
  }

  /** Link an existing server to its cloud server (servers:manage). */
  @Put("link")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(OobLinkSchema)
  @ApiZodResponse(OobStatusSchema)
  link(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(OobLinkSchema)) body: OobLinkInput) {
    return this.oob.link(user.userId, id, body);
  }

  @Delete("link")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(OobStatusSchema)
  unlink(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.oob.unlink(user.userId, id);
  }
}

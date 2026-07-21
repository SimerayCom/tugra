import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { TunnelService } from "./tunnel.service";
import {
  SetAppTunnelInput,
  SetAppTunnelSchema,
  SetupTunnelInput,
  SetupTunnelSchema,
} from "./dto/tunnel.schemas";

@ApiTags("servers")
@ApiSecurity("pat")
@Controller("servers/:id/tunnel")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class TunnelController {
  constructor(private readonly tunnel: TunnelService) {}

  @Get()
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.tunnel.status(user.userId, id);
  }

  @Post()
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(SetupTunnelSchema)
  setup(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetupTunnelSchema)) body: SetupTunnelInput,
  ) {
    return this.tunnel.setup(user.userId, id, body);
  }

  @Delete()
  @RequireScopes("deploy")
  @HttpCode(200)
  async teardown(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.tunnel.teardown(user.userId, id);
    return { ok: true };
  }
}

@ApiTags("apps")
@ApiSecurity("pat")
@Controller("apps/:id/tunnel")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class AppTunnelController {
  constructor(private readonly tunnel: TunnelService) {}

  @Put()
  @HttpCode(200)
  @ApiZodBody(SetAppTunnelSchema)
  setExposed(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetAppTunnelSchema)) body: SetAppTunnelInput,
  ) {
    return this.tunnel.setAppExposed(user.userId, id, body.exposed);
  }
}

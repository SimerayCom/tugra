import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody } from "../openapi/openapi";
import { publicUrlFrom, type ReqLike } from "../common/hub-url";
import { CoolifyTakeoverService } from "./coolify-takeover.service";
import { EnableSchema, GenerateSchema, ListQuerySchema, type EnableInput, type GenerateInput, type ListQuery } from "./dto";

/**
 * "Read this Coolify" (no Coolify API): a read-only inventory of a Coolify instance, read through the agent on its host.
 * Team OWNER/ADMIN only; each server needs an explicit opt-in first; every step is audited. The inventory holds no secret
 * values. The install commands in the checklist embed an enroll token, so they need `read:secrets` like the server install
 * endpoint they come from.
 */
@ApiTags("coolify-takeover")
@ApiSecurity("pat")
@Controller("coolify-takeover")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class CoolifyTakeoverController {
  constructor(private readonly takeover: CoolifyTakeoverService) {}

  /** The opted-in servers of a team and their last-read counts. */
  @Get("inventories")
  list(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(ListQuerySchema)) q: ListQuery) {
    return this.takeover.list(user.userId, q.teamId);
  }

  /** The stored inventory of one opted-in server (the whole Coolify, grouped by Coolify team in the client). */
  @Get("servers/:serverId")
  get(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string) {
    return this.takeover.get(user.userId, serverId);
  }

  /** Is a Coolify database running on this server? Reads nothing from it. */
  @Post("servers/:serverId/detect")
  @HttpCode(200)
  @RequireScopes("write")
  detect(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string) {
    return this.takeover.detect(user.userId, serverId);
  }

  /** Opt this server in (explicit). */
  @Post("servers/:serverId/enable")
  @HttpCode(200)
  @RequireScopes("write")
  @ApiZodBody(EnableSchema)
  enable(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string, @Body(new ZodValidationPipe(EnableSchema)) _body: EnableInput) {
    return this.takeover.enable(user.userId, serverId);
  }

  /** Read the Coolify database now (read-only, no secrets) and store the inventory. */
  @Post("servers/:serverId/read")
  @HttpCode(200)
  @RequireScopes("write")
  read(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string) {
    return this.takeover.read(user.userId, serverId);
  }

  /** Withdraw the opt-in and delete the stored inventory. */
  @Delete("servers/:serverId")
  @RequireScopes("write")
  disable(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string) {
    return this.takeover.disable(user.userId, serverId);
  }

  /** "Add all Coolify servers": the checklist with the install command per server. Nothing is run. */
  @Get("servers/:serverId/servers")
  @RequireScopes("read:secrets")
  checklist(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string, @Req() req: ReqLike) {
    return this.takeover.checklist(user.userId, serverId, publicUrlFrom(req));
  }

  /** Create the pending Tugra servers for the chosen Coolify servers (team mapping per server) and return the checklist. */
  @Post("servers/:serverId/servers")
  @HttpCode(200)
  @RequireScopes("write", "read:secrets")
  @ApiZodBody(GenerateSchema)
  generate(
    @CurrentUser() user: AuthUser,
    @Param("serverId") serverId: string,
    @Body(new ZodValidationPipe(GenerateSchema)) body: GenerateInput,
    @Req() req: ReqLike,
  ) {
    return this.takeover.generate(user.userId, serverId, body, publicUrlFrom(req));
  }
}

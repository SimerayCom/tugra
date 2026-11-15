import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { AppMovesService } from "./app-moves.service";
import {
  AppMoveViewSchema,
  MoveAppPreflightResultSchema,
  MoveAppPreflightSchema,
  OkSchema,
  StartAppMoveResultSchema,
  StartAppMoveSchema,
  type MoveAppPreflightInput,
  type StartAppMoveInput,
} from "./dto";

/**
 * Move an app to another server (same app id, data included). Preflight is read-only (it probes both agents but
 * changes nothing); every route is team-scoped in the service: mutations need apps:config + apps:deploy + backups,
 * reads need membership (plan/acks/log tail are writer-only).
 */
@ApiTags("apps")
@ApiSecurity("pat")
@Controller("apps")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class AppMovesController {
  constructor(private readonly moves: AppMovesService) {}

  @Post(":id/move/preflight")
  @HttpCode(200)
  @RequireScopes("write")
  @ApiZodBody(MoveAppPreflightSchema)
  @ApiZodResponse(MoveAppPreflightResultSchema)
  preflight(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(MoveAppPreflightSchema)) body: MoveAppPreflightInput,
  ) {
    return this.moves.preflight(user.userId, id, body);
  }

  /** Start the move (202): the preflight is re-run server-side. Wrapped by the Idempotency-Key interceptor like any POST. */
  @Post(":id/move")
  @HttpCode(202)
  @RequireScopes("write")
  @ApiZodBody(StartAppMoveSchema)
  @ApiZodResponse(StartAppMoveResultSchema, { status: 202 })
  start(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(StartAppMoveSchema)) body: StartAppMoveInput,
  ) {
    return this.moves.start(user.userId, id, body);
  }

  @Get(":id/moves")
  @ApiZodResponse(AppMoveViewSchema, { isArray: true })
  list(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query("active") active?: string, @Query("limit") limit?: string) {
    const n = limit === undefined ? undefined : Number(limit);
    return this.moves.list(user.userId, id, { active: active === "true", limit: Number.isFinite(n) ? n : undefined });
  }

  @Get(":id/moves/:moveId")
  @ApiZodResponse(AppMoveViewSchema)
  get(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("moveId") moveId: string) {
    return this.moves.get(user.userId, id, moveId);
  }

  /** Cancel before the cutover (409 move_past_cutover afterwards). */
  @Post(":id/moves/:moveId/cancel")
  @HttpCode(200)
  @RequireScopes("write")
  @ApiZodResponse(OkSchema)
  async cancel(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("moveId") moveId: string) {
    await this.moves.cancel(user.userId, id, moveId);
    return { ok: true as const };
  }

  /** Remove the move's archived source volumes (or a rolled-back/failed move's target leftovers) now. */
  @Post(":id/moves/:moveId/purge-source")
  @HttpCode(200)
  @RequireScopes("write")
  @ApiZodResponse(OkSchema)
  async purgeSource(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("moveId") moveId: string) {
    await this.moves.purgeSource(user.userId, id, moveId);
    return { ok: true as const };
  }
}

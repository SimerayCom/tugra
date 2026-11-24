import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CostsService } from "./costs.service";
import { CostsAdviceService } from "./costs-advice.service";
import { RescaleService } from "./rescale.service";
import {
  AdviceReportSchema,
  CostsReportSchema,
  CreateBaselineInput,
  CreateBaselineSchema,
  RescaleInput,
  RescaleSchema,
  RescaleStatusSchema,
  RescaleViewSchema,
  SetServerCostInput,
  SetServerCostSchema,
  SyncResultSchema,
} from "./costs.dto";

/**
 * Server prices, the before/after bill, size advice and one-click rescale. Reads: any member of the team (a token needs
 * `read`). Typing a price or saving a bill: `servers:manage`; reading prices from the provider: `servers:ops`; a
 * rescale shuts a server down, so it needs `servers:manage` and a `deploy` scope token and the server's name typed.
 */
@ApiTags("costs")
@ApiSecurity("pat")
@Controller("costs")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class CostsController {
  constructor(
    private readonly costs: CostsService,
    private readonly advice: CostsAdviceService,
    private readonly rescale: RescaleService,
  ) {}

  /** Prices, per-app shares and the before/after comparison of one team (`teamId`) or of every team of the caller. */
  @Get()
  @ApiZodResponse(CostsReportSchema)
  report(@CurrentUser() user: AuthUser, @Query("teamId") teamId?: string) {
    return this.costs.report(user.userId, teamId || undefined);
  }

  /** Size advice per server: can go down (saves ~X), near its limit, or still learning (needs 14 days of metrics). */
  @Get("advice")
  @ApiZodResponse(AdviceReportSchema)
  adviceList(@CurrentUser() user: AuthUser, @Query("teamId") teamId?: string) {
    return this.advice.advice(user.userId, teamId || undefined);
  }

  /** Read the real prices from the providers of the team's linked servers. Never overwrites a price someone typed. */
  @Post("sync")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(SyncResultSchema)
  sync(@CurrentUser() user: AuthUser, @Query("teamId") teamId: string) {
    return this.costs.sync(user.userId, teamId ?? "");
  }

  /** Save the "before" bill: the current prices (omit `monthly`) or a total typed by hand. */
  @Post("baselines")
  @ApiZodBody(CreateBaselineSchema)
  createBaseline(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateBaselineSchema)) body: CreateBaselineInput) {
    return this.costs.createBaseline(user.userId, body);
  }

  @Delete("baselines/:id")
  @HttpCode(200)
  deleteBaseline(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.costs.deleteBaseline(user.userId, id);
  }

  /** Type the real monthly price of a server (replaces the provider / estimated figure until cleared). */
  @Put("servers/:serverId")
  @HttpCode(200)
  @ApiZodBody(SetServerCostSchema)
  setServerCost(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string, @Body(new ZodValidationPipe(SetServerCostSchema)) body: SetServerCostInput) {
    return this.costs.setServerCost(user.userId, serverId, body);
  }

  @Delete("servers/:serverId")
  @HttpCode(200)
  clearServerCost(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string) {
    return this.costs.clearServerCost(user.userId, serverId);
  }

  /** The latest one-click rescale of a server and how far it got. */
  @Get("servers/:serverId/rescale")
  @ApiZodResponse(RescaleStatusSchema)
  rescaleStatus(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string) {
    return this.rescale.status(user.userId, serverId);
  }

  /** Rescale a cloud-linked server through its provider API: shut down, change size, power on (needs the server's name). */
  @Post("servers/:serverId/rescale")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(RescaleSchema)
  @ApiZodResponse(RescaleViewSchema)
  startRescale(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string, @Body(new ZodValidationPipe(RescaleSchema)) body: RescaleInput) {
    return this.rescale.start(user.userId, serverId, body);
  }
}

import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ServerStatus } from "@prisma/client";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ServersService } from "../servers/servers.service";
import { MetricsService } from "../metrics/metrics.service";
import { CleanupService } from "./cleanup.service";
import { PatchService } from "./patch.service";
import { CleanupConfigBulkInput, CleanupConfigBulkSchema, FleetLatestRowSchema, FleetPatchInput, FleetPatchSchema } from "./dto";

/** Fleet-wide bulk operations (cross-team, role-gated per server). */
@ApiTags("servers")
@ApiSecurity("pat")
@Controller("fleet")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class FleetController {
  constructor(
    private readonly cleanup: CleanupService,
    private readonly patch: PatchService,
    private readonly servers: ServersService,
    private readonly metrics: MetricsService,
  ) {}

  // Fleet overview: the newest metrics sample for every server the caller can see, in ONE call
  // (DISTINCT ON over [serverId, ts]) — the live-table source. listForUser scopes the id set to the
  // caller's teams, so a bulk metrics read can never leak another team's servers. Read-level (no scope).
  @Get("metrics/latest")
  @ApiZodResponse(FleetLatestRowSchema, { isArray: true })
  async latestMetrics(
    @CurrentUser() user: AuthUser,
    @Query("teamId") teamId?: string,
    @Query("status") status?: ServerStatus,
    @Query("q") q?: string,
  ) {
    const servers = await this.servers.listForUser(user.userId, { teamId, status, q });
    return this.metrics.latestForServers(servers.map((s) => s.id));
  }

  @Post("cleanup-config")
  @HttpCode(200)
  @ApiZodBody(CleanupConfigBulkSchema)
  bulkCleanupConfig(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CleanupConfigBulkSchema)) body: CleanupConfigBulkInput,
  ) {
    return this.cleanup.setConfigBulk(user.userId, body.serverIds, body);
  }

  // Check OS package updates across many servers at once (each role-gated; non-writable skipped).
  @Post("updates/check")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(FleetPatchSchema)
  bulkCheckUpdates(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(FleetPatchSchema)) body: FleetPatchInput,
  ) {
    return this.patch.checkUpdatesBulk(user.userId, body.serverIds);
  }

  // Apply all OS package updates across many servers at once. Reboots are never automatic.
  @Post("updates/apply")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(FleetPatchSchema)
  bulkUpgradeAll(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(FleetPatchSchema)) body: FleetPatchInput,
  ) {
    return this.patch.upgradeAllBulk(user.userId, body.serverIds);
  }
}

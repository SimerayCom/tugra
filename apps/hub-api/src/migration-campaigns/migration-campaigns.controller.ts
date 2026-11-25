import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { runActorFromAuth } from "../migration-runs/core/run-contract";
import { MigrationCampaignsService } from "./migration-campaigns.service";
import { CampaignCreateSchema, CampaignListQuerySchema, CampaignPlanSchema, type CampaignCreateInput, type CampaignListQuery, type CampaignPlanInput } from "./dto";
import { z } from "zod";

const ViewsQuery = z.object({ sessionId: z.string().min(1).max(64), planHash: z.string().regex(/^[a-f0-9]{32}$/) }).strict();

/**
 * Placement per source server and the campaign of guided runs a mixed placement becomes. Team OWNER only for the actions that create
 * or cancel runs; every one is audited by the service. Nothing here returns a secret.
 */
@ApiTags("import")
@ApiSecurity("pat")
@Controller("migration-campaigns")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class MigrationCampaignsController {
  constructor(private readonly campaigns: MigrationCampaignsService) {}

  /** What each source server of a session offers (in place or another server, and why not), with no choice made. */
  @Get("placement")
  @RequireScopes("deploy")
  views(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(ViewsQuery)) q: z.infer<typeof ViewsQuery>) {
    return this.campaigns.views(user.userId, q);
  }

  /** Check a placement and show the runs it would create. Writes nothing. */
  @Post("plan")
  @HttpCode(200)
  @RequireScopes("deploy")
  plan(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CampaignPlanSchema)) body: CampaignPlanInput) {
    return this.campaigns.preview(user.userId, body);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(CampaignListQuerySchema)) q: CampaignListQuery) {
    return this.campaigns.list(user.userId, q.teamId);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.campaigns.get(user.userId, id);
  }

  /** Create the campaign and its runs (201). Owner only. */
  @Post()
  @RequireScopes("deploy", "read:secrets")
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CampaignCreateSchema)) body: CampaignCreateInput) {
    return this.campaigns.create(runActorFromAuth(user), body);
  }

  /** Abort the runs that have not started and cancel the campaign. Owner only. */
  @Post(":id/cancel")
  @HttpCode(200)
  @RequireScopes("deploy")
  cancel(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.campaigns.cancel(runActorFromAuth(user), id);
  }
}

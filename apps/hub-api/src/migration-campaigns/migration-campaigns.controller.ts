import { Body, Controller, Get, Header, HttpCode, Logger, NotFoundException, Param, Post, Query, StreamableFile, UseGuards } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { CampaignView } from "@tugra/shared";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { runActorFromAuth } from "../migration-runs/core/run-contract";
import { CampaignAdvancerService } from "./campaign-advancer.service";
import { PlanIconService } from "./plan-icons.service";
import { MigrationCampaignsService } from "./migration-campaigns.service";
import { CampaignCreateSchema, CampaignListQuerySchema, CampaignPlanSchema, CampaignViewsQuerySchema, PlanIconQuerySchema, type CampaignViewsQuery, type PlanIconQuery, type CampaignCreateInput, type CampaignListQuery, type CampaignPlanInput } from "./dto";
import { z } from "zod";

/**
 * Placement per source server and the campaign of guided runs a mixed placement becomes. Team OWNER only for the actions that create
 * or cancel runs; every one is audited by the service. Nothing here returns a secret.
 */
@ApiTags("import")
@ApiSecurity("pat")
@Controller("migration-campaigns")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class MigrationCampaignsController {
  private readonly logger = new Logger(MigrationCampaignsController.name);

  constructor(
    private readonly campaigns: MigrationCampaignsService,
    private readonly advancer: CampaignAdvancerService,
    private readonly icons: PlanIconService,
  ) {}

  /**
   * The icon of an app in a move plan, before it exists in Tugra: a site's favicon (`kind=site`, a host name) or the avatar of its repository's GitHub
   * owner (`kind=github`). The hub fetches it (public addresses only), so the browser contacts neither site. 404 when there is none; the page then
   * falls back to the brand of the image or a plain icon.
   */
  @Get("icon")
  @SkipThrottle() // one <img> per app of a plan; a miss is not browser-cached, so the global limit would starve real API calls. The fetches a user starts are capped in the service instead.
  @Header("X-Content-Type-Options", "nosniff")
  @Header("Content-Security-Policy", "default-src 'none'; sandbox")
  @Header("Cache-Control", "private, max-age=86400")
  async icon(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(PlanIconQuerySchema)) q: PlanIconQuery): Promise<StreamableFile> {
    const found = await this.icons.get(q.kind, q.name, user.userId);
    if (!found) throw new NotFoundException("no icon");
    return new StreamableFile(found.data, { type: found.mime });
  }

  /** What each source server of a session offers (in place or another server, and why not), with no choice made. */
  @Get("placement")
  @RequireScopes("deploy")
  views(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(CampaignViewsQuerySchema)) q: CampaignViewsQuery) {
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

  /**
   * Create the campaign and its runs (201), and hand it to the hub (unless `start` is false): the creation and the first start are one request, so a closed
   * tab cannot leave the runs queued. A campaign that cannot be handed over stays as made (its runs queued) and the page offers "Start all". Owner only.
   */
  @Post()
  @RequireScopes("deploy", "read:secrets")
  async create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CampaignCreateSchema)) body: CampaignCreateInput) {
    const actor = runActorFromAuth(user);
    const made = await this.campaigns.create(actor, body);
    if (body.start === false) return made;
    const views: CampaignView[] = [];
    for (const v of made.campaigns) {
      try {
        if (body.dryRun) {
          // a dry run is looked at, not driven: the hub holds the later servers behind it, so only the first one is started
          await this.campaigns.startFirstRun(actor, v);
          views.push(v);
        } else {
          views.push(await this.advancer.start(actor, v.id));
        }
      } catch (e) {
        this.logger.warn(`campaign ${v.id} was made but not handed over: ${e instanceof Error ? e.message : String(e)}`);
        views.push(v);
      }
    }
    return { ...views[0], campaigns: views };
  }

  /** Abort the runs that have not started and cancel the campaign. Owner only. */
  @Post(":id/cancel")
  @HttpCode(200)
  @RequireScopes("deploy")
  cancel(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.campaigns.cancel(runActorFromAuth(user), id);
  }

  /** "Start all": the hub starts each queued run in wave order and goes on by itself while the earlier waves are safe. Creator and team owner only. */
  @Post(":id/start")
  @HttpCode(200)
  @RequireScopes("deploy")
  start(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.advancer.start(runActorFromAuth(user), id);
  }

  /** Stop starting new servers; a run already started keeps going. Creator and team owner only. */
  @Post(":id/pause")
  @HttpCode(200)
  @RequireScopes("deploy")
  pause(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.advancer.pause(runActorFromAuth(user), id);
  }
}

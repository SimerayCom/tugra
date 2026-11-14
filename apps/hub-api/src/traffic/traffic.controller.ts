import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ServersService } from "../servers/servers.service";
import { TeamAccessService } from "../common/team-access.service";
import { loadProjectCtx } from "../common/resource-project";
import { PrismaService } from "../prisma/prisma.service";
import { HostResolverService, normalizeHost } from "./host-resolver.service";
import { TrafficService } from "./traffic.service";
import {
  TrafficBreakdownQuery,
  TrafficBreakdownQuerySchema,
  TrafficBreakdownSchema,
  TrafficCountriesQuery,
  TrafficCountriesQuerySchema,
  TrafficCountriesSchema,
  TrafficDomainRowSchema,
  TrafficDomainsQuery,
  TrafficDomainsQuerySchema,
  TrafficPathsQuery,
  TrafficPathsQuerySchema,
  TrafficPathsSchema,
  TrafficQuery,
  TrafficQuerySchema,
  TrafficSummarySchema,
} from "./dto";

/**
 * Visitor-traffic analytics (read-level, no scope). Authz mirrors the fleet endpoints: the visible server
 * set comes from ServersService.listForUser (the caller's teams, optionally narrowed by ?teamId) and every
 * query is constrained to exactly that id set, so another team's traffic can never be returned.
 */
@ApiTags("traffic")
@ApiSecurity("pat")
@Controller("traffic")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class TrafficController {
  constructor(
    private readonly servers: ServersService,
    private readonly traffic: TrafficService,
    private readonly access: TeamAccessService,
    private readonly prisma: PrismaService,
    private readonly resolver: HostResolverService,
  ) {}

  private async visibleServerIds(userId: string, teamId?: string): Promise<string[]> {
    const servers = await this.servers.listForUser(userId, { teamId });
    return servers.map((s) => s.id);
  }

  /**
   * The (servers, host filter) a query reads. Without `appId` this is exactly the team-wide scope (visible servers,
   * the caller's `domain` passed straight through). With `appId` it is ONE app on ONE server, filtered to the hosts
   * that app owns:
   *  - the app must sit on a server the caller can see, and the caller needs per-resource access to it (a restricted
   *    member without a grant gets 403); a missing or invisible app yields an empty scope, so existence isn't leaked;
   *  - the hosts are the authoritative per-server resolver map (the one ingest attributes with: first writer wins)
   *    filtered to this app, so a host another app owns, even a shared alias, is never included;
   *  - `domain` narrows within those hosts; an empty host set returns NO servers, never an unfiltered query.
   */
  private async resolveScope(userId: string, q: { teamId?: string; domain?: string; appId?: string }): Promise<{ serverIds: string[]; domain: string | string[] | undefined }> {
    const serverIds = await this.visibleServerIds(userId, q.teamId);
    if (!q.appId) return { serverIds, domain: q.domain };
    const none = { serverIds: [] as string[], domain: undefined };
    const app = await this.prisma.application.findUnique({
      where: { id: q.appId },
      select: { id: true, teamId: true, serverId: true, environmentId: true },
    });
    if (!app || !serverIds.includes(app.serverId)) return none;
    await this.access.requireResourceAccess(userId, app.teamId, {
      resourceId: app.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, app.environmentId).then((c) => c.projectId),
    });
    let hosts = [...(await this.resolver.forServer(app.serverId))].filter(([, v]) => v.appId === app.id).map(([h]) => h);
    if (q.domain) {
      const want = normalizeHost(q.domain);
      hosts = hosts.filter((h) => h === want);
    }
    if (hosts.length === 0) return none;
    return { serverIds: [app.serverId], domain: hosts.slice(0, 100) };
  }

  // Distinct hosts with recent traffic on visible servers (the UI domain filter), with the owning app when known.
  @Get("domains")
  @ApiZodResponse(TrafficDomainRowSchema, { isArray: true })
  async domains(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(TrafficDomainsQuerySchema)) q: TrafficDomainsQuery,
  ) {
    return this.traffic.domains(await this.visibleServerIds(user.userId, q.teamId), q.range);
  }

  // Aligned time series (requests, status classes, bytes) + totals; long ranges are rolled up at query time.
  @Get("summary")
  @ApiZodResponse(TrafficSummarySchema)
  async summary(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(TrafficQuerySchema)) q: TrafficQuery,
  ) {
    const scope = await this.resolveScope(user.userId, q);
    return this.traffic.summary(scope.serverIds, q.range, scope.domain);
  }

  // Top paths over the range, ordered by requests.
  @Get("paths")
  @ApiZodResponse(TrafficPathsSchema)
  async paths(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(TrafficPathsQuerySchema)) q: TrafficPathsQuery,
  ) {
    const scope = await this.resolveScope(user.userId, q);
    return this.traffic.paths(scope.serverIds, q.range, scope.domain, q.limit);
  }

  // Requests per visitor country over the range, ordered by requests.
  @Get("countries")
  @ApiZodResponse(TrafficCountriesSchema)
  async countries(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(TrafficCountriesQuerySchema)) q: TrafficCountriesQuery,
  ) {
    const scope = await this.resolveScope(user.userId, q);
    return this.traffic.countries(scope.serverIds, q.range, scope.domain, q.limit);
  }

  // Top keys of one visitor dimension (browser|os|device|referrer|city|network) over the range, ordered by requests.
  @Get("breakdown")
  @ApiZodResponse(TrafficBreakdownSchema)
  async breakdown(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(TrafficBreakdownQuerySchema)) q: TrafficBreakdownQuery,
  ) {
    const scope = await this.resolveScope(user.userId, q);
    return this.traffic.breakdown(scope.serverIds, q.dim, q.range, scope.domain, q.limit);
  }
}

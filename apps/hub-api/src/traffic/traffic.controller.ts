import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ServersService } from "../servers/servers.service";
import { TrafficService } from "./traffic.service";
import {
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
  ) {}

  private async visibleServerIds(userId: string, teamId?: string): Promise<string[]> {
    const servers = await this.servers.listForUser(userId, { teamId });
    return servers.map((s) => s.id);
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
    return this.traffic.summary(await this.visibleServerIds(user.userId, q.teamId), q.range, q.domain);
  }

  // Top paths over the range, ordered by requests.
  @Get("paths")
  @ApiZodResponse(TrafficPathsSchema)
  async paths(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(TrafficPathsQuerySchema)) q: TrafficPathsQuery,
  ) {
    return this.traffic.paths(await this.visibleServerIds(user.userId, q.teamId), q.range, q.domain, q.limit);
  }

  // Requests per visitor country over the range, ordered by requests.
  @Get("countries")
  @ApiZodResponse(TrafficCountriesSchema)
  async countries(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(TrafficCountriesQuerySchema)) q: TrafficCountriesQuery,
  ) {
    return this.traffic.countries(await this.visibleServerIds(user.userId, q.teamId), q.range, q.domain, q.limit);
  }
}

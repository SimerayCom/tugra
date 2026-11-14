import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { RolloutCreateInput, RolloutCreateSchema, RolloutPlanViewSchema, RolloutViewSchema, RolloutsService } from "./rollouts.service";

/**
 * Fleet rollouts: redeploy a set of apps in health-gated waves (canary → steps), halting on failure and resumable
 * by the operator. Slice 1 redeploys each app's CURRENT source (no version pin yet); fleet rollback is a later
 * slice. Creating/halting/resuming/cancelling is deploy-class → 'deploy' scope; the service enforces apps:deploy
 * on the team plus the caller's per-resource scoping for every app, all-or-nothing.
 */
@ApiTags("rollouts")
@ApiSecurity("pat")
@Controller("rollouts")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class RolloutsController {
  constructor(private readonly rollouts: RolloutsService) {}

  @Get()
  @ApiZodResponse(RolloutViewSchema, { isArray: true })
  list(@CurrentUser() user: AuthUser, @Query("teamId") teamId?: string, @Query("status") status?: string) {
    return this.rollouts.list(user.userId, { teamId, status });
  }

  /** Dry run: wave plan + per-app preflight (blocked / warnings) for the exact body create would take. */
  @Post("plan")
  @HttpCode(200)
  @ApiZodBody(RolloutCreateSchema)
  @ApiZodResponse(RolloutPlanViewSchema)
  plan(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(RolloutCreateSchema)) body: RolloutCreateInput) {
    return this.rollouts.plan(user.userId, body);
  }

  @Post()
  @RequireScopes("deploy")
  @ApiZodBody(RolloutCreateSchema)
  @ApiZodResponse(RolloutViewSchema, { status: 201 })
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(RolloutCreateSchema)) body: RolloutCreateInput) {
    return this.rollouts.create(user.userId, body);
  }

  @Get(":id")
  @ApiZodResponse(RolloutViewSchema)
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.rollouts.get(user.userId, id);
  }

  @Post(":id/halt")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(RolloutViewSchema)
  halt(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.rollouts.halt(user.userId, id);
  }

  @Post(":id/resume")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(RolloutViewSchema)
  resume(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.rollouts.resume(user.userId, id);
  }

  /** Fleet rollback: revert every app this rollout moved to its pre-rollout baseline (from HALTED or COMPLETED). */
  @Post(":id/rollback")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(RolloutViewSchema)
  rollback(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.rollouts.rollback(user.userId, id);
  }

  @Post(":id/cancel")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(RolloutViewSchema)
  cancel(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.rollouts.cancel(user.userId, id);
  }
}

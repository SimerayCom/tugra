import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CoolifyInPlaceService } from "./coolify-inplace.service";
import { GiveBackSchema, ListQuerySchema, PlanSchema, SwapSchema, type GiveBackInput, type ListQuery, type PlanInput, type SwapInput } from "./dto";

/**
 * Take a server over in place: plan, test (Tugra's proxy with no published port), swap the ports, verify with new certificates, give back to
 * Coolify. Team OWNER only (the service re-checks the role on every call); every action is audited. Nothing here returns a secret.
 */
@ApiTags("coolify-inplace")
@ApiSecurity("pat")
@Controller("coolify-inplace")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class CoolifyInPlaceController {
  constructor(private readonly inplace: CoolifyInPlaceService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(ListQuerySchema)) q: ListQuery) {
    return this.inplace.list(user.userId, q.serverId);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.inplace.get(user.userId, id);
  }

  /** Read what Coolify runs on the server (read-only) and map it to the Tugra apps. */
  @Post("plan")
  @RequireScopes("write")
  plan(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(PlanSchema)) body: PlanInput) {
    return this.inplace.plan(user.userId, body);
  }

  /** Adopt the images, start Tugra's side and test every domain. Safe to repeat. */
  @Post(":id/test")
  @HttpCode(200)
  @RequireScopes("write", "deploy")
  test(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.inplace.test(user.userId, id);
  }

  /** Take the ports. Needs a passed test and the server's name typed. */
  @Post(":id/swap")
  @HttpCode(200)
  @RequireScopes("write", "deploy")
  swap(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(SwapSchema)) body: SwapInput) {
    return this.inplace.swap(user.userId, id, body);
  }

  /** Re-check every domain and work on the new certificates (a few domains per call; call again until verified). */
  @Post(":id/verify")
  @HttpCode(200)
  @RequireScopes("write", "deploy")
  verify(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.inplace.verify(user.userId, id);
  }

  /** One click back to Coolify. Needs the server's name typed. */
  @Post(":id/give-back")
  @HttpCode(200)
  @RequireScopes("write", "deploy")
  giveBack(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(GiveBackSchema)) body: GiveBackInput) {
    return this.inplace.giveBack(user.userId, id, body);
  }
}

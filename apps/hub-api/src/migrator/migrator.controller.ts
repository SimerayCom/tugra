import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { MigratorService } from "./migrator.service";
import { AdoptSchema, type AdoptInput } from "./dto";

@ApiTags("servers")
@ApiSecurity("pat")
@Controller("servers/:id")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class MigratorController {
  constructor(private readonly migrator: MigratorService) {}

  /** Scan the host for foreign containers. Env values may be secrets → read:secrets scope. */
  @Get("discover")
  @RequireScopes("read:secrets")
  discover(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.migrator.discover(user.userId, id);
  }

  /** Adopt a foreign container as a Tugra app (POST → default "write" scope). */
  @Post("adopt")
  @ApiZodBody(AdoptSchema)
  adopt(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(AdoptSchema)) body: AdoptInput,
  ) {
    return this.migrator.adopt(user.userId, id, body);
  }
}

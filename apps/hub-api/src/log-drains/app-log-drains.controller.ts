import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import {
  CreateAppLogDrainInput,
  CreateAppLogDrainSchema,
  UpdateAppLogDrainInput,
  UpdateAppLogDrainSchema,
} from "../server-ops/dto";
import { AppLogDrainService } from "./app-log-drain.service";

/** Per-app log drains (D7). Writer-only: apps:config on the app's team; the token is never returned. */
@ApiTags("apps")
@ApiSecurity("pat")
@Controller("apps/:id/log-drains")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class AppLogDrainsController {
  constructor(private readonly drains: AppLogDrainService) {}

  // A drain row carries a destination URL/host and options: secrets-adjacent, so a read-only PAT needs read:secrets.
  @Get()
  @RequireScopes("read:secrets")
  list(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.drains.list(user.userId, id);
  }

  @Post()
  @ApiZodBody(CreateAppLogDrainSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CreateAppLogDrainSchema)) body: CreateAppLogDrainInput,
  ) {
    return this.drains.create(user.userId, id, body);
  }

  @Put(":drainId")
  @HttpCode(200)
  @ApiZodBody(UpdateAppLogDrainSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("drainId") drainId: string,
    @Body(new ZodValidationPipe(UpdateAppLogDrainSchema)) body: UpdateAppLogDrainInput,
  ) {
    return this.drains.update(user.userId, id, drainId, body);
  }

  @Delete(":drainId")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("drainId") drainId: string) {
    await this.drains.remove(user.userId, id, drainId);
    return { ok: true };
  }
}

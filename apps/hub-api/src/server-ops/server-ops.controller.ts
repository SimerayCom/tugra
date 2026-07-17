import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  type MessageEvent,
  Param,
  Post,
  Put,
  Query,
  Sse,
  UseGuards,
} from "@nestjs/common";
import { concat, EMPTY, from, map, mergeMap, type Observable } from "rxjs";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CleanupService } from "./cleanup.service";
import { PatchService } from "./patch.service";
import { LogDrainService } from "./log-drain.service";
import { ProxyOpsService } from "./proxy-ops.service";
import {
  CleanupConfigInput,
  CleanupConfigSchema,
  CreateLogDrainInput,
  CreateLogDrainSchema,
  UpdateLogDrainInput,
  UpdateLogDrainSchema,
} from "./dto";

@ApiTags("servers")
@ApiSecurity("pat")
@Controller("servers/:id")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ServerOpsController {
  constructor(
    private readonly cleanup: CleanupService,
    private readonly patch: PatchService,
    private readonly logDrains: LogDrainService,
    private readonly proxy: ProxyOpsService,
  ) {}

  @Get("proxy")
  proxyStatus(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.proxy.status(user.userId, id);
  }

  @Post("proxy/start")
  @RequireScopes("deploy")
  @HttpCode(200)
  proxyStart(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.proxy.start(user.userId, id);
  }

  @Post("proxy/stop")
  @RequireScopes("deploy")
  @HttpCode(200)
  proxyStop(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.proxy.stop(user.userId, id);
  }

  @Post("proxy/restart")
  @RequireScopes("deploy")
  @HttpCode(200)
  proxyRestart(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.proxy.restart(user.userId, id);
  }

  @Get("proxy/logs")
  proxyLogs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("tail") tail?: string,
  ) {
    return this.proxy.logs(user.userId, id, tail ? Number(tail) : undefined);
  }

  @Get("log-drains")
  listLogDrains(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.logDrains.list(user.userId, id);
  }

  @Post("log-drains")
  @ApiZodBody(CreateLogDrainSchema)
  createLogDrain(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CreateLogDrainSchema)) body: CreateLogDrainInput,
  ) {
    return this.logDrains.create(user.userId, id, body);
  }

  @Put("log-drains/:drainId")
  @HttpCode(200)
  @ApiZodBody(UpdateLogDrainSchema)
  updateLogDrain(
    @CurrentUser() user: AuthUser,
    @Param("drainId") drainId: string,
    @Body(new ZodValidationPipe(UpdateLogDrainSchema)) body: UpdateLogDrainInput,
  ) {
    return this.logDrains.update(user.userId, drainId, body);
  }

  @Delete("log-drains/:drainId")
  @HttpCode(200)
  async deleteLogDrain(@CurrentUser() user: AuthUser, @Param("drainId") drainId: string) {
    await this.logDrains.remove(user.userId, drainId);
    return { ok: true };
  }

  @Get("updates")
  checkUpdates(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.patch.checkUpdates(user.userId, id);
  }

  @Post("updates/apply")
  @RequireScopes("deploy")
  @HttpCode(200)
  upgradeAll(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.patch.upgradeAll(user.userId, id);
  }

  @Post("updates/apply/:pkg")
  @RequireScopes("deploy")
  @HttpCode(200)
  upgradeOne(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("pkg") pkg: string) {
    return this.patch.upgradeOne(user.userId, id, pkg);
  }

  /** Live patch-log stream (SSE). Completes when no patch run is active. */
  @Sse("updates/stream")
  streamLogs(@CurrentUser() user: AuthUser, @Param("id") id: string): Observable<MessageEvent> {
    return from(this.patch.streamLogs(user.userId, id)).pipe(
      mergeMap((sub) => (sub ? concat(from(sub.replay), sub.live) : EMPTY)),
      map((event) => ({ data: JSON.stringify(event) }) as MessageEvent),
    );
  }

  @Post("cleanup")
  @RequireScopes("deploy")
  @HttpCode(200)
  cleanupNow(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.cleanup.cleanupNow(user.userId, id);
  }

  @Put("cleanup-config")
  @HttpCode(200)
  @ApiZodBody(CleanupConfigSchema)
  async setConfig(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CleanupConfigSchema)) body: CleanupConfigInput,
  ) {
    await this.cleanup.setConfig(user.userId, id, body);
    return { ok: true };
  }
}

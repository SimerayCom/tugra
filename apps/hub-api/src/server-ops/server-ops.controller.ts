import {
  Body,
  Controller,
  Get,
  HttpCode,
  type MessageEvent,
  Param,
  Post,
  Put,
  Sse,
  UseGuards,
} from "@nestjs/common";
import { concat, EMPTY, from, map, mergeMap, type Observable } from "rxjs";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CleanupService } from "./cleanup.service";
import { PatchService } from "./patch.service";
import { CleanupConfigInput, CleanupConfigSchema } from "./dto";

@Controller("servers/:id")
@UseGuards(ApiAuthGuard)
export class ServerOpsController {
  constructor(
    private readonly cleanup: CleanupService,
    private readonly patch: PatchService,
  ) {}

  @Get("updates")
  checkUpdates(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.patch.checkUpdates(user.userId, id);
  }

  @Post("updates/apply")
  @HttpCode(200)
  upgradeAll(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.patch.upgradeAll(user.userId, id);
  }

  @Post("updates/apply/:pkg")
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
  @HttpCode(200)
  cleanupNow(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.cleanup.cleanupNow(user.userId, id);
  }

  @Put("cleanup-config")
  @HttpCode(200)
  async setConfig(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CleanupConfigSchema)) body: CleanupConfigInput,
  ) {
    await this.cleanup.setConfig(user.userId, id, body);
    return { ok: true };
  }
}

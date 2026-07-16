import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { VolumeBackupsService } from "./volume-backups.service";
import { VolumeBackupConfigInput, VolumeBackupConfigSchema } from "./dto";

@Controller("apps/:appId/volume-backups")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class VolumeBackupsController {
  constructor(private readonly svc: VolumeBackupsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param("appId") appId: string) {
    return this.svc.list(user.userId, appId);
  }

  @Post()
  @HttpCode(200)
  backupNow(@CurrentUser() user: AuthUser, @Param("appId") appId: string) {
    return this.svc.backupNow(user.userId, appId);
  }

  @Post(":id/restore")
  @RequireScopes("deploy")
  @HttpCode(200)
  async restore(@CurrentUser() user: AuthUser, @Param("appId") appId: string, @Param("id") id: string) {
    await this.svc.restore(user.userId, appId, id);
    return { ok: true };
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("appId") appId: string, @Param("id") id: string) {
    await this.svc.remove(user.userId, appId, id);
    return { ok: true };
  }

  @Put("config")
  @HttpCode(200)
  setConfig(
    @CurrentUser() user: AuthUser,
    @Param("appId") appId: string,
    @Body(new ZodValidationPipe(VolumeBackupConfigSchema)) body: VolumeBackupConfigInput,
  ) {
    return this.svc.setSchedule(user.userId, appId, body);
  }
}

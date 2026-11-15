import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { VolumeBackupConfigViewSchema, VolumeBackupsService, VolumeBackupViewSchema, VolumePolicyViewSchema } from "./volume-backups.service";
import {
  ExportUrlInput,
  ExportUrlSchema,
  VolumeBackupConfigInput,
  VolumeBackupConfigSchema,
  VolumeImportFromUrlInput,
  VolumeImportFromUrlSchema,
  VolumePolicyInput,
  VolumePolicySchema,
} from "./dto";

@ApiTags("volume-backups")
@ApiSecurity("pat")
@Controller("apps/:appId/volume-backups")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class VolumeBackupsController {
  constructor(private readonly svc: VolumeBackupsService) {}

  @Get()
  @ApiZodResponse(VolumeBackupViewSchema, { isArray: true })
  list(@CurrentUser() user: AuthUser, @Param("appId") appId: string) {
    return this.svc.list(user.userId, appId);
  }

  @Post()
  @HttpCode(200)
  @ApiZodResponse(VolumeBackupViewSchema, { isArray: true })
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

  @Post("import-from-url")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(VolumeImportFromUrlSchema)
  async importFromUrl(
    @CurrentUser() user: AuthUser,
    @Param("appId") appId: string,
    @Body(new ZodValidationPipe(VolumeImportFromUrlSchema)) body: VolumeImportFromUrlInput,
  ) {
    await this.svc.importFromUrl(user.userId, appId, body);
    return { ok: true };
  }

  // Presigned migration URL — grants time-limited download of the backup data → read:secrets.
  @Post(":id/export-url")
  @RequireScopes("read:secrets")
  @HttpCode(200)
  @ApiZodBody(ExportUrlSchema)
  exportUrl(
    @CurrentUser() user: AuthUser,
    @Param("appId") appId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ExportUrlSchema)) body: ExportUrlInput,
  ) {
    return this.svc.exportUrl(user.userId, appId, id, body.expireHours ?? 24);
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("appId") appId: string, @Param("id") id: string) {
    await this.svc.remove(user.userId, appId, id);
    return { ok: true };
  }

  @Get("config")
  @ApiZodResponse(VolumeBackupConfigViewSchema)
  getConfig(@CurrentUser() user: AuthUser, @Param("appId") appId: string) {
    return this.svc.getConfig(user.userId, appId);
  }

  // Per-volume policy: its own cron/interval (or off) and retention, overriding the app-wide schedule.
  @Put("policies/:volumeName")
  @HttpCode(200)
  @ApiZodBody(VolumePolicySchema)
  @ApiZodResponse(VolumePolicyViewSchema)
  putPolicy(
    @CurrentUser() user: AuthUser,
    @Param("appId") appId: string,
    @Param("volumeName") volumeName: string,
    @Body(new ZodValidationPipe(VolumePolicySchema)) body: VolumePolicyInput,
  ) {
    return this.svc.putPolicy(user.userId, appId, volumeName, body);
  }

  @Delete("policies/:volumeName")
  @HttpCode(200)
  async deletePolicy(@CurrentUser() user: AuthUser, @Param("appId") appId: string, @Param("volumeName") volumeName: string) {
    await this.svc.deletePolicy(user.userId, appId, volumeName);
    return { ok: true };
  }

  @Put("config")
  @HttpCode(200)
  @ApiZodBody(VolumeBackupConfigSchema)
  setConfig(
    @CurrentUser() user: AuthUser,
    @Param("appId") appId: string,
    @Body(new ZodValidationPipe(VolumeBackupConfigSchema)) body: VolumeBackupConfigInput,
  ) {
    return this.svc.setSchedule(user.userId, appId, body);
  }
}

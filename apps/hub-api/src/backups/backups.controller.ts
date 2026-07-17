import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { BackupsService, BackupViewSchema, RestoreViewSchema } from "./backups.service";
import {
  BackupConfigInput,
  BackupConfigSchema,
  ImportFromUrlInput,
  ImportFromUrlSchema,
} from "./dto";

@ApiTags("backups")
@ApiSecurity("pat")
@Controller("databases/:id")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get("backups")
  @ApiZodResponse(BackupViewSchema, { isArray: true })
  list(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.backups.list(user.userId, id);
  }

  @Get("restores")
  @ApiZodResponse(RestoreViewSchema, { isArray: true })
  listRestores(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.backups.listRestores(user.userId, id);
  }

  @Post("backups")
  @ApiZodResponse(BackupViewSchema, { status: 201 })
  backupNow(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.backups.backupNow(user.userId, id);
  }

  @Post("backups/import-from-url")
  @RequireScopes("deploy") // restore-class: runs the same destructive runRestore path (overwrites the DB)
  @HttpCode(200)
  @ApiZodBody(ImportFromUrlSchema)
  async importFromUrl(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ImportFromUrlSchema)) body: ImportFromUrlInput,
  ) {
    await this.backups.importFromUrl(user.userId, id, body);
    return { ok: true };
  }

  @Post("backups/:backupId/restore")
  @RequireScopes("deploy")
  @HttpCode(200)
  async restore(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("backupId") backupId: string,
  ) {
    await this.backups.restore(user.userId, id, backupId);
    return { ok: true };
  }

  @Post("backups/:backupId/restore-to/:targetId")
  @RequireScopes("deploy")
  @HttpCode(200)
  async restoreTo(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("backupId") backupId: string,
    @Param("targetId") targetId: string,
  ) {
    await this.backups.restoreTo(user.userId, id, backupId, targetId);
    return { ok: true };
  }

  @Delete("backups/:backupId")
  @HttpCode(200)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("backupId") backupId: string,
  ) {
    await this.backups.removeBackup(user.userId, id, backupId);
    return { ok: true };
  }

  @Put("backup-config")
  @HttpCode(200)
  @ApiZodBody(BackupConfigSchema)
  async setSchedule(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(BackupConfigSchema)) body: BackupConfigInput,
  ) {
    await this.backups.setSchedule(user.userId, id, body);
    return { ok: true };
  }
}

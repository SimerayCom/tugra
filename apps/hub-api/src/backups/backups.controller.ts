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
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { BackupsService } from "./backups.service";
import {
  BackupConfigInput,
  BackupConfigSchema,
  ImportFromUrlInput,
  ImportFromUrlSchema,
} from "./dto";

@Controller("databases/:id")
@UseGuards(ApiAuthGuard)
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get("backups")
  list(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.backups.list(user.userId, id);
  }

  @Post("backups")
  backupNow(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.backups.backupNow(user.userId, id);
  }

  @Post("backups/import-from-url")
  @HttpCode(200)
  async importFromUrl(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ImportFromUrlSchema)) body: ImportFromUrlInput,
  ) {
    await this.backups.importFromUrl(user.userId, id, body);
    return { ok: true };
  }

  @Post("backups/:backupId/restore")
  @HttpCode(200)
  async restore(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("backupId") backupId: string,
  ) {
    await this.backups.restore(user.userId, id, backupId);
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
  async setSchedule(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(BackupConfigSchema)) body: BackupConfigInput,
  ) {
    await this.backups.setSchedule(user.userId, id, body);
    return { ok: true };
  }
}

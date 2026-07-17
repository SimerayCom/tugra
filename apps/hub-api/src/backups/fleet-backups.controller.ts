import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { BackupsService } from "./backups.service";
import { BackupConfigBulkInput, BackupConfigBulkSchema } from "./dto";

/** Fleet-wide bulk backup-schedule op (cross-team, role-gated per database). */
@ApiTags("backups")
@ApiSecurity("pat")
@Controller("fleet")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class FleetBackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Post("backup-config")
  @HttpCode(200)
  @ApiZodBody(BackupConfigBulkSchema)
  bulkBackupConfig(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(BackupConfigBulkSchema)) body: BackupConfigBulkInput,
  ) {
    return this.backups.setScheduleBulk(user.userId, body.databaseIds, body);
  }
}

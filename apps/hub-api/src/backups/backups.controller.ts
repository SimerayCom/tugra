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
import { BackupsService, BackupViewSchema, BaseBackupViewSchema, RestoreViewSchema } from "./backups.service";
import { PitrService, PitrStatusSchema } from "./pitr.service";
import { PitrRestoreService, PitrRestoreStartSchema, PitrWindowSchema } from "./pitr-restore.service";
import {
  BackupConfigInput,
  BackupConfigSchema,
  BaseBackupConfigInput,
  BaseBackupConfigSchema,
  ExportUrlInput,
  ExportUrlSchema,
  ImportFromUrlInput,
  ImportFromUrlSchema,
  PitrConfigInput,
  PitrConfigSchema,
  PitrRestoreInput,
  PitrRestoreSchema,
  VerifyConfigInput,
  VerifyConfigSchema,
} from "./dto";

@ApiTags("backups")
@ApiSecurity("pat")
@Controller("databases/:id")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class BackupsController {
  constructor(
    private readonly backups: BackupsService,
    private readonly pitr: PitrService,
    private readonly pitrRestore: PitrRestoreService,
  ) {}

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

  // Physical base backup (pg_basebackup) — the PITR base image. Postgres-only; recorded separately from
  // logical backups so it never appears in the backups list / restore / verify paths.
  @Get("base-backups")
  @ApiZodResponse(BaseBackupViewSchema, { isArray: true })
  listBaseBackups(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.backups.listBaseBackups(user.userId, id);
  }

  @Post("base-backups")
  @ApiZodResponse(BaseBackupViewSchema, { status: 201 })
  baseBackupNow(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.backups.baseBackupNow(user.userId, id);
  }

  @Delete("base-backups/:baseId")
  @HttpCode(200)
  async removeBaseBackup(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("baseId") baseId: string) {
    await this.backups.removeBaseBackup(user.userId, id, baseId);
    return { ok: true };
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

  // Restore-verification drill: provision a disposable throwaway, restore this backup INTO it, attest the
  // outcome (VERIFY Restore row on the source), tear the throwaway down. restore-class (runs runRestore +
  // provisions a real DB) → 'deploy' scope; the service additionally enforces the 'databases' permission.
  @Post("backups/verify-latest")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(RestoreViewSchema)
  verifyLatest(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.backups.verifyBackupNow(user.userId, id);
  }

  @Post("backups/:backupId/verify")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(RestoreViewSchema)
  verify(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("backupId") backupId: string) {
    return this.backups.verifyBackupNow(user.userId, id, backupId);
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

  // Presigned migration URL — grants time-limited download of the backup data → read:secrets.
  @Post("backups/:backupId/export-url")
  @RequireScopes("read:secrets")
  @HttpCode(200)
  @ApiZodBody(ExportUrlSchema)
  exportUrl(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("backupId") backupId: string,
    @Body(new ZodValidationPipe(ExportUrlSchema)) body: ExportUrlInput,
  ) {
    return this.backups.exportUrl(user.userId, id, backupId, body.expireHours ?? 24);
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

  // Arm/disarm the scheduled restore-verify drill. Config write, gated at the service by
  // requireWrite('backups') + 'databases' (arming recurring system provisioning), like backup-config.
  @Put("verify-config")
  @HttpCode(200)
  @ApiZodBody(VerifyConfigSchema)
  async setVerifySchedule(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(VerifyConfigSchema)) body: VerifyConfigInput,
  ) {
    await this.backups.setVerifySchedule(user.userId, id, body);
    return { ok: true };
  }

  // Arm/disarm the scheduled physical base backup (the PITR anchor). Config write, gated at the service by
  // requireWrite('backups') + 'databases', like verify-config.
  @Put("base-backup-config")
  @HttpCode(200)
  @ApiZodBody(BaseBackupConfigSchema)
  async setBaseBackupSchedule(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(BaseBackupConfigSchema)) body: BaseBackupConfigInput,
  ) {
    await this.backups.setBaseBackupSchedule(user.userId, id, body);
    return { ok: true };
  }

  // ── PITR (point-in-time recovery) — Postgres only ──

  @Get("pitr")
  @ApiZodResponse(PitrStatusSchema)
  pitrStatus(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.pitr.status(user.userId, id);
  }

  // Enable recreates the container with WAL archiving on (a one-time restart), verifies archiving end to end and
  // auto-rolls back on failure; disable drains the spool first. Recreate-class → 'deploy' scope (like provision),
  // and the service additionally requires the 'databases' + 'backups' permissions.
  @Put("pitr")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(PitrConfigSchema)
  @ApiZodResponse(PitrStatusSchema)
  setPitr(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(PitrConfigSchema)) body: PitrConfigInput,
  ) {
    return body.enabled ? this.pitr.enable(user.userId, id) : this.pitr.disable(user.userId, id, { purgeSpool: body.purgeSpool });
  }

  // The recoverable window (read-level): which base backups + archived WAL can serve a point-in-time restore.
  @Get("pitr/window")
  @ApiZodResponse(PitrWindowSchema)
  pitrWindow(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.pitrRestore.window(user.userId, id);
  }

  // Restore AS OF a moment into a NEW database. Minutes-to-hours (seed + stage + replay), so it is ASYNC: 202 with
  // the ids; progress is the Restore row (kind PITR, listed under this database) and the new database's status.
  // Recreate-class → 'deploy' scope; the service additionally requires 'databases' + 'backups' (+ 'apps:config'
  // for a custom image).
  @Post("pitr/restore")
  @RequireScopes("deploy")
  @HttpCode(202)
  @ApiZodBody(PitrRestoreSchema)
  @ApiZodResponse(PitrRestoreStartSchema, { status: 202 })
  async pitrRestoreToTime(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(PitrRestoreSchema)) body: PitrRestoreInput,
  ) {
    const r = await this.pitrRestore.start(user.userId, id, body);
    return { restoreId: r.restoreId, databaseId: r.databaseId };
  }
}

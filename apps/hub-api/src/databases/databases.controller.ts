import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  type MessageEvent,
  Param,
  Post,
  Put,
  Query,
  Sse,
  StreamableFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { Paginated } from "../common/pagination.decorator";
import { SetTagsSchema, type SetTagsInput } from "../common/tags";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { parseDate, str } from "../audit/audit.controller";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { RedactSecretsInterceptor } from "../api-tokens/redact-secrets.interceptor";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { DatabasesService, DatabaseViewSchema, CloneDatabaseResponseSchema } from "./databases.service";
import { DatabaseLogStreamGuard } from "./log-stream.guard";
import {
  CloneDatabaseInput,
  CloneDatabaseSchema,
  CreateDatabaseInput,
  CreateDatabaseSchema,
  SetDatabaseEnvInput,
  SetDatabaseEnvSchema,
  SetDatabaseVolumesInput,
  SetDatabaseVolumesSchema,
  RenameInput,
  RenameSchema,
  SetIconInput,
  SetIconSchema,
  SetDatabaseLimitsInput,
  SetDatabaseLimitsSchema,
  SetDatabasePortInput,
  SetDatabasePortSchema,
  SetEnvironmentInput,
  SetEnvironmentSchema,
  MoveDatabaseServerInput,
  MoveDatabaseServerSchema,
} from "./dto";

@ApiTags("databases")
@ApiSecurity("pat")
@Controller("databases")
@UseGuards(ApiAuthGuard, ScopesGuard)
@UseInterceptors(new RedactSecretsInterceptor(["password", "connectionUri", "username", "internalHost"]))
export class DatabasesController {
  constructor(private readonly databases: DatabasesService) {}

  @Get()
  @ApiZodResponse(DatabaseViewSchema, { isArray: true })
  @Paginated()
  list(@CurrentUser() user: AuthUser, @Query("q") q?: string) {
    return this.databases.list(user.userId, q);
  }

  @Post()
  @ApiZodBody(CreateDatabaseSchema)
  @ApiZodResponse(DatabaseViewSchema, { status: 201 })
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateDatabaseSchema)) body: CreateDatabaseInput,
  ) {
    return this.databases.create(user.userId, body);
  }

  @Get(":id")
  @ApiZodResponse(DatabaseViewSchema)
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.databases.get(user.userId, id);
  }

  // This database's audit history (every actor; membership + per-resource access gate it). ?action=&from=&to=&cursor=.
  @Get(":id/audit")
  listAudit(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("cursor") cursor?: string,
    @Query("action") action?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.databases.listAudit(user.userId, id, { cursor: str(cursor), action: str(action), from: parseDate(from), to: parseDate(to) });
  }

  @Post(":id/provision")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(DatabaseViewSchema)
  provision(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.databases.provision(user.userId, id);
  }

  @Post(":id/stop")
  @RequireScopes("deploy")
  @HttpCode(200)
  async stop(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.databases.stop(user.userId, id);
    return { ok: true };
  }

  /**
   * Live database-log follow (SSE). Writer-only; logs may contain credentials. The guard authorizes
   * BEFORE @Sse commits a 200 stream so a rejection surfaces as a real HTTP status (403/503).
   */
  @Sse(":id/logs/stream")
  @RequireScopes("read:secrets") // live database logs may contain secrets
  @UseGuards(DatabaseLogStreamGuard)
  async streamLogs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("tail") tail?: string,
    @Query("follow") follow?: string,
    @Query("since") since?: string,
    @Query("search") search?: string,
  ): Promise<Observable<MessageEvent>> {
    const stream = await this.databases.streamLogs(user.userId, id, {
      tail: tail ? Number(tail) : undefined,
      follow: follow !== "0",
      since,
      search,
    });
    return stream.pipe(map((event) => ({ data: JSON.stringify(event) }) as MessageEvent));
  }

  /** One-shot log export (writer-only) — returns the collected logs as a downloadable text file. */
  @Get(":id/logs/download")
  @RequireScopes("read:secrets") // exported logs may contain secrets
  @Header("Content-Type", "text/plain; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="database.log"')
  downloadLogs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("tail") tail?: string,
    @Query("since") since?: string,
  ): Promise<string> {
    return this.databases.downloadLogs(user.userId, id, {
      tail: tail ? Number(tail) : undefined,
      since,
    });
  }

  /** Per-container metrics history for the database's Metrics tab (read-level). */
  @Get(":id/metrics/containers")
  containerMetrics(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("range") range?: string,
  ) {
    return this.databases.containerMetrics(user.userId, id, range);
  }

  @Put(":id/environment")
  @HttpCode(200)
  @ApiZodBody(SetEnvironmentSchema)
  async setEnvironment(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetEnvironmentSchema)) body: SetEnvironmentInput,
  ) {
    await this.databases.setEnvironment(user.userId, id, body.environmentId);
    return { ok: true };
  }

  // Move the database to another server in the same team. Safe only before first deploy (NEW) — the service
  // refuses a provisioned database (its data can't cross servers; back up + restore to a new DB instead).
  @Put(":id/server")
  @HttpCode(200)
  @ApiZodBody(MoveDatabaseServerSchema)
  async moveToServer(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(MoveDatabaseServerSchema)) body: MoveDatabaseServerInput,
  ) {
    await this.databases.moveToServer(user.userId, id, body.serverId);
    return { ok: true };
  }

  @Put(":id/tags")
  @HttpCode(200)
  @ApiZodBody(SetTagsSchema)
  async setTags(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetTagsSchema)) body: SetTagsInput,
  ) {
    await this.databases.setTags(user.userId, id, body.tags);
    return { ok: true };
  }

  @Put(":id/limits")
  @HttpCode(200)
  @ApiZodBody(SetDatabaseLimitsSchema)
  async setLimits(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetDatabaseLimitsSchema)) body: SetDatabaseLimitsInput,
  ) {
    await this.databases.setLimits(user.userId, id, body);
    return { ok: true };
  }

  @Put(":id/name")
  @HttpCode(200)
  @ApiZodBody(RenameSchema)
  async rename(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RenameSchema)) body: RenameInput,
  ) {
    await this.databases.rename(user.userId, id, body.name);
    return { ok: true };
  }

  // A database's user-set container env vars. Sensitive (values may be secrets): the service is writer-only
  // and the GET needs the read:secrets scope, exactly like the app env endpoints.
  @Get(":id/env")
  @RequireScopes("read:secrets")
  getEnv(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.databases.getEnv(user.userId, id);
  }

  @Put(":id/env")
  @HttpCode(200)
  @ApiZodBody(SetDatabaseEnvSchema)
  async setEnv(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetDatabaseEnvSchema)) body: SetDatabaseEnvInput,
  ) {
    await this.databases.setEnv(user.userId, id, body.env);
    return { ok: true };
  }

  // Extra persistent volumes for this database (names + absolute container paths). Writer-gated; not secret,
  // so they ride on the read-level database view rather than a dedicated secret-scoped GET.
  @Put(":id/volumes")
  @HttpCode(200)
  @ApiZodBody(SetDatabaseVolumesSchema)
  async setVolumes(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetDatabaseVolumesSchema)) body: SetDatabaseVolumesInput,
  ) {
    await this.databases.setVolumes(user.userId, id, body.volumes);
    return { ok: true };
  }

  @Post(":id/clone")
  @ApiZodBody(CloneDatabaseSchema)
  @ApiZodResponse(CloneDatabaseResponseSchema, { status: 201 })
  async clone(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CloneDatabaseSchema)) body: CloneDatabaseInput,
  ) {
    return this.databases.clone(user.userId, id, body);
  }

  @Put(":id/port")
  @HttpCode(200)
  @ApiZodBody(SetDatabasePortSchema)
  async setPort(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetDatabasePortSchema)) body: SetDatabasePortInput,
  ) {
    await this.databases.setPort(user.userId, id, body.hostPort);
    return { ok: true };
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query("keepVolume") keepVolume?: string) {
    await this.databases.remove(user.userId, id, { keepVolume: keepVolume === "1" });
    return { ok: true };
  }

  /**
   * The database's custom icon as a raw PNG (read-level; 404 when none). Served from our own origin, locked
   * down with a fixed image/png type, nosniff and a strict CSP. Cache-bust with ?v=<iconUpdatedAt>.
   */
  @Get(":id/icon")
  @Header("X-Content-Type-Options", "nosniff")
  @Header("Content-Security-Policy", "default-src 'none'; sandbox")
  @Header("Cache-Control", "private, max-age=60")
  async getIcon(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<StreamableFile> {
    const icon = await this.databases.getIcon(user.userId, id);
    return new StreamableFile(icon.data, { type: icon.mime });
  }

  @Put(":id/icon")
  @HttpCode(200)
  @ApiZodBody(SetIconSchema)
  async setIcon(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetIconSchema)) body: SetIconInput,
  ) {
    await this.databases.setIcon(user.userId, id, body.data);
    return { ok: true };
  }

  @Delete(":id/icon")
  @RequireScopes("write") // removing a cosmetic icon is a write op, not a destructive admin one
  @HttpCode(200)
  async deleteIcon(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.databases.deleteIcon(user.userId, id);
    return { ok: true };
  }
}

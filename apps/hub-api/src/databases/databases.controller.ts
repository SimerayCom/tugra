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
import { DatabasesService, DatabaseViewSchema } from "./databases.service";
import { DatabaseLogStreamGuard } from "./log-stream.guard";
import {
  CreateDatabaseInput,
  CreateDatabaseSchema,
  RenameInput,
  RenameSchema,
  SetDatabaseLimitsInput,
  SetDatabaseLimitsSchema,
  SetDatabasePortInput,
  SetDatabasePortSchema,
  SetEnvironmentInput,
  SetEnvironmentSchema,
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
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.databases.remove(user.userId, id);
    return { ok: true };
  }
}

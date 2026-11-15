import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiProduces, ApiQuery, ApiSecurity, ApiTags } from "@nestjs/swagger";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  Fs2StatSchema,
  FilesMetaSchema,
  FsWriteResultSchema,
  VolChmodBodySchema,
  VolContentQuerySchema,
  VolDeleteQuerySchema,
  VolMkdirBodySchema,
  VolPutQuerySchema,
  VolRenameBodySchema,
  VolStatQuerySchema,
  type VolChmodBody,
  type VolContentQuery,
  type VolDeleteQuery,
  type VolMkdirBody,
  type VolPutQuery,
  type VolRenameBody,
  type VolStatQuery,
} from "./dto";
import { FsRateLimitedException } from "./fs-errors";
import { FilesService } from "./files.service";

/** Run a mutation and, when the per-user limiter refuses it, surface the wait as a Retry-After header. */
export async function withRetryAfter<T>(res: ServerResponse | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FsRateLimitedException && res && !res.headersSent) res.setHeader("Retry-After", String(e.retryAfterSec));
    throw e;
  }
}

/**
 * File manager on an app's DECLARED volumes: meta, stat, download, upload, new folder, rename, chmod, delete. The
 * legacy `GET apps/:id/files` (list) lives, unchanged, on ApplicationsController. Every route needs the team
 * permission `apps:config` (via the service) and the server capabilities its (scope, op) needs — reads `files`,
 * mutations `files` + `files_write`. PAT scopes are ALL-of and explicit, never the method default: reads need
 * `read:secrets` (file content is application data), writes `write` + `read:secrets`, DELETE `admin`.
 */
@ApiTags("apps")
@ApiSecurity("pat")
@Controller("apps")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /** What the UI may offer for this app: capability/permission/agent/deploy state per volume and for the container FS. */
  @Get(":id/files/meta")
  @RequireScopes("read:secrets")
  @ApiZodResponse(FilesMetaSchema)
  meta(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.files.meta(user.userId, id);
  }

  /** stat one entry (never dereferences a symlink). An empty path is the volume root. */
  @Get(":id/files/stat")
  @RequireScopes("read:secrets")
  @ApiQuery({ name: "volume", required: true, type: String })
  @ApiQuery({ name: "path", required: false, type: String, description: "volume-relative path; empty = the volume root" })
  @ApiZodResponse(Fs2StatSchema)
  stat(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query(new ZodValidationPipe(VolStatQuerySchema)) q: VolStatQuery) {
    return this.files.stat(user.userId, id, { volume: q.volume }, q.path);
  }

  /** Download one regular file (attachment). Streamed agent -> hub -> browser without staging on the hub. */
  @Get(":id/files/content")
  @RequireScopes("read:secrets")
  @ApiQuery({ name: "volume", required: true, type: String })
  @ApiQuery({ name: "path", required: true, type: String })
  @ApiProduces("application/octet-stream")
  async download(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(VolContentQuerySchema)) q: VolContentQuery,
    @Res() res: ServerResponse,
  ): Promise<void> {
    await this.files.download(user.userId, id, { volume: q.volume }, q.path, res);
  }

  /** Upload (create or replace) one file from the raw request body. 201 when created, 200 when replaced. */
  @Put(":id/files/content")
  @RequireScopes("write", "read:secrets")
  @ApiConsumes("application/octet-stream")
  @ApiBody({ schema: { type: "string", format: "binary" } })
  @ApiQuery({ name: "volume", required: true, type: String })
  @ApiQuery({ name: "path", required: true, type: String })
  @ApiQuery({ name: "overwrite", required: false, schema: { type: "string", enum: ["0", "1"] } })
  @ApiQuery({ name: "mode", required: false, type: String, description: "octal permission bits (<= 0777)" })
  @ApiQuery({ name: "ifMatch", required: false, type: String, description: "etag of the version being replaced" })
  @ApiQuery({ name: "acknowledgeRisk", required: false, schema: { type: "string", enum: ["0", "1"] }, description: "1 = write into a running datastore volume anyway" })
  @ApiZodResponse(FsWriteResultSchema, { status: 200 })
  async upload(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(VolPutQuerySchema)) q: VolPutQuery,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    const r = await withRetryAfter(res, () => this.files.upload(user.userId, id, { volume: q.volume }, q, req));
    res.statusCode = r.created ? 201 : 200;
    return r.body;
  }

  /** Create a folder (optionally with parents). */
  @Post(":id/files/mkdir")
  @HttpCode(201)
  @RequireScopes("write", "read:secrets")
  @ApiZodBody(VolMkdirBodySchema)
  @ApiZodResponse(Fs2StatSchema, { status: 201 })
  mkdir(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(VolMkdirBodySchema)) b: VolMkdirBody,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    return withRetryAfter(res, () => this.files.mkdir(user.userId, id, { volume: b.volume }, b));
  }

  /** Rename / move within the volume (the destination must not exist). */
  @Post(":id/files/rename")
  @HttpCode(200)
  @RequireScopes("write", "read:secrets")
  @ApiZodBody(VolRenameBodySchema)
  @ApiZodResponse(Fs2StatSchema)
  rename(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(VolRenameBodySchema)) b: VolRenameBody,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    return withRetryAfter(res, () => this.files.rename(user.userId, id, { volume: b.volume }, b));
  }

  /** Change permission bits (<= 0777, never recursive, never through a symlink). */
  @Post(":id/files/chmod")
  @HttpCode(200)
  @RequireScopes("write", "read:secrets")
  @ApiZodBody(VolChmodBodySchema)
  @ApiZodResponse(Fs2StatSchema)
  chmod(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(VolChmodBodySchema)) b: VolChmodBody,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    return withRetryAfter(res, () => this.files.chmod(user.userId, id, { volume: b.volume }, b));
  }

  /** Delete a file or folder (recursive=1 for a non-empty folder). Needs the `admin` token scope. */
  @Delete(":id/files")
  @HttpCode(204)
  @RequireScopes("admin")
  @ApiQuery({ name: "volume", required: true, type: String })
  @ApiQuery({ name: "path", required: true, type: String })
  @ApiQuery({ name: "recursive", required: false, schema: { type: "string", enum: ["0", "1"] } })
  @ApiQuery({ name: "acknowledgeRisk", required: false, schema: { type: "string", enum: ["0", "1"] } })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(VolDeleteQuerySchema)) q: VolDeleteQuery,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<void> {
    await withRetryAfter(res, () => this.files.remove(user.userId, id, { volume: q.volume }, q));
  }
}

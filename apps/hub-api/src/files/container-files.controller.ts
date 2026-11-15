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
  CtrChmodBodySchema,
  CtrDeleteQuerySchema,
  CtrListQuerySchema,
  CtrMkdirBodySchema,
  CtrPutQuerySchema,
  CtrRenameBodySchema,
  CtrStatQuerySchema,
  Fs2StatSchema,
  FsContainerListingSchema,
  FsWriteResultSchema,
  type CtrChmodBody,
  type CtrDeleteQuery,
  type CtrListQuery,
  type CtrMkdirBody,
  type CtrPutQuery,
  type CtrRenameBody,
  type CtrStatQuery,
} from "./dto";
import { FilesService } from "./files.service";
import { withRetryAfter } from "./files.controller";

/**
 * The LIVE container filesystem of an app (/app, /etc, ...). Ephemeral: changes are lost when the container is
 * recreated. Beyond `apps:config`, every route needs the team permission `terminal` AND the server capabilities
 * `files` + `terminal` (reads) / + `files_write` (mutations); no separate owner flag exists. Reads, writes and
 * mkdir go through `docker cp`, which the Docker daemon performs as container-root: they ignore the image's USER and
 * file modes, so they can reach files an interactive shell as that user could not. Rename, chmod and delete run as the
 * image's default user, like the shell. Because this edits a running app's runtime, EVERY mutation needs the
 * `admin` token scope (reads: `read:secrets`). A single-container app ignores `container`; a COMPOSE app must name
 * one of its own containers. Clustered apps are refused.
 */
@ApiTags("apps")
@ApiSecurity("pat")
@Controller("apps")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ContainerFilesController {
  constructor(private readonly files: FilesService) {}

  /** List a container directory (honest-partial for huge trees: `truncated`). */
  @Get(":id/container-files")
  @RequireScopes("read:secrets")
  @ApiQuery({ name: "container", required: false, type: String, description: "required for COMPOSE apps" })
  @ApiQuery({ name: "path", required: false, type: String, description: "absolute in-container path (default /)" })
  @ApiZodResponse(FsContainerListingSchema)
  list(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query(new ZodValidationPipe(CtrListQuerySchema)) q: CtrListQuery) {
    return this.files.listContainer(user.userId, id, { container: q.container ?? "" }, q.path);
  }

  @Get(":id/container-files/stat")
  @RequireScopes("read:secrets")
  @ApiQuery({ name: "container", required: false, type: String })
  @ApiQuery({ name: "path", required: true, type: String })
  @ApiZodResponse(Fs2StatSchema)
  stat(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query(new ZodValidationPipe(CtrStatQuerySchema)) q: CtrStatQuery) {
    return this.files.stat(user.userId, id, { container: q.container ?? "" }, q.path);
  }

  @Get(":id/container-files/content")
  @RequireScopes("read:secrets")
  @ApiQuery({ name: "container", required: false, type: String })
  @ApiQuery({ name: "path", required: true, type: String })
  @ApiProduces("application/octet-stream")
  async download(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(CtrStatQuerySchema)) q: CtrStatQuery,
    @Res() res: ServerResponse,
  ): Promise<void> {
    await this.files.download(user.userId, id, { container: q.container ?? "" }, q.path, res);
  }

  /** Replace or create one file (not atomic: the daemon extracts in place). */
  @Put(":id/container-files/content")
  @RequireScopes("admin")
  @ApiConsumes("application/octet-stream")
  @ApiBody({ schema: { type: "string", format: "binary" } })
  @ApiQuery({ name: "container", required: false, type: String })
  @ApiQuery({ name: "path", required: true, type: String })
  @ApiQuery({ name: "overwrite", required: false, schema: { type: "string", enum: ["0", "1"] } })
  @ApiQuery({ name: "mode", required: false, type: String })
  @ApiQuery({ name: "ifMatch", required: false, type: String })
  @ApiZodResponse(FsWriteResultSchema, { status: 200 })
  async upload(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(CtrPutQuerySchema)) q: CtrPutQuery,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    const r = await withRetryAfter(res, () => this.files.upload(user.userId, id, { container: q.container ?? "" }, q, req));
    res.statusCode = r.created ? 201 : 200;
    return r.body;
  }

  @Post(":id/container-files/mkdir")
  @HttpCode(201)
  @RequireScopes("admin")
  @ApiZodBody(CtrMkdirBodySchema)
  @ApiZodResponse(Fs2StatSchema, { status: 201 })
  mkdir(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CtrMkdirBodySchema)) b: CtrMkdirBody,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    return withRetryAfter(res, () => this.files.mkdir(user.userId, id, { container: b.container ?? "" }, b));
  }

  /** Needs `mv` in the image; otherwise 409 `no_binary`. */
  @Post(":id/container-files/rename")
  @HttpCode(200)
  @RequireScopes("admin")
  @ApiZodBody(CtrRenameBodySchema)
  @ApiZodResponse(Fs2StatSchema)
  rename(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CtrRenameBodySchema)) b: CtrRenameBody,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    return withRetryAfter(res, () => this.files.rename(user.userId, id, { container: b.container ?? "" }, b));
  }

  /** Needs `chmod` in the image; otherwise 409 `no_binary`. */
  @Post(":id/container-files/chmod")
  @HttpCode(200)
  @RequireScopes("admin")
  @ApiZodBody(CtrChmodBodySchema)
  @ApiZodResponse(Fs2StatSchema)
  chmod(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CtrChmodBodySchema)) b: CtrChmodBody,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    return withRetryAfter(res, () => this.files.chmod(user.userId, id, { container: b.container ?? "" }, b));
  }

  /** Needs `rm` / `rmdir` in the image; otherwise 409 `no_binary`. */
  @Delete(":id/container-files")
  @HttpCode(204)
  @RequireScopes("admin")
  @ApiQuery({ name: "container", required: false, type: String })
  @ApiQuery({ name: "path", required: true, type: String })
  @ApiQuery({ name: "recursive", required: false, schema: { type: "string", enum: ["0", "1"] } })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(CtrDeleteQuerySchema)) q: CtrDeleteQuery,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<void> {
    await withRetryAfter(res, () => this.files.remove(user.userId, id, { container: q.container ?? "" }, q));
  }
}

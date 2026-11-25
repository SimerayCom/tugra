import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody } from "../openapi/openapi";
import { ProjectMovesService } from "./project-moves.service";
import { PreviewProjectMoveSchema, RollbackProjectMoveSchema, StartProjectMoveSchema, type PreviewProjectMoveInput, type RollbackProjectMoveInput, type StartProjectMoveInput } from "./dto";

/**
 * Move a project and everything under it to another server. Team OWNER only for everything that changes something; members who can see
 * the project may read its moves. The preview changes nothing.
 */
@ApiTags("project-moves")
@ApiSecurity("pat")
@Controller("project-moves")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ProjectMovesController {
  constructor(private readonly moves: ProjectMovesService) {}

  @Post("preview")
  @HttpCode(200)
  @RequireScopes("write")
  @ApiZodBody(PreviewProjectMoveSchema)
  preview(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(PreviewProjectMoveSchema)) body: PreviewProjectMoveInput) {
    return this.moves.preview(user.userId, body);
  }

  /** Start the move (202): the preview is re-run server-side and any blocker refuses it. */
  @Post()
  @HttpCode(202)
  @RequireScopes("write")
  @ApiZodBody(StartProjectMoveSchema)
  start(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(StartProjectMoveSchema)) body: StartProjectMoveInput) {
    return this.moves.start(user.userId, body);
  }

  @Get("project/:projectId")
  list(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string) {
    return this.moves.list(user.userId, projectId);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.moves.get(user.userId, id);
  }

  /** Before any app has moved; the move then rolls back by itself. */
  @Post(":id/cancel")
  @HttpCode(200)
  @RequireScopes("write")
  async cancel(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.moves.cancel(user.userId, id);
    return { ok: true as const };
  }

  /**
   * Undo a move that ended FAILED (some apps moved, some did not): the apps that moved go back, the databases are brought up to date on the
   * source, the links are put back and the copies are removed. Owner only, the project's name typed. 202: the undo runs in the background.
   */
  @Post(":id/rollback")
  @HttpCode(202)
  @RequireScopes("write")
  @ApiZodBody(RollbackProjectMoveSchema)
  rollback(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(RollbackProjectMoveSchema)) body: RollbackProjectMoveInput) {
    return this.moves.rollback(user.userId, id, body);
  }

  /** Remove the safety copy now (the old databases and the apps' archived volumes). */
  @Post(":id/purge-safety-copy")
  @HttpCode(200)
  @RequireScopes("write")
  purge(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.moves.purgeSafetyCopy(user.userId, id);
  }
}

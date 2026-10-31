import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { Paginated } from "../common/pagination.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ProjectsService, ProjectViewSchema } from "./projects.service";
import {
  CreateEnvironmentInput,
  CreateEnvironmentSchema,
  CreateProjectInput,
  CreateProjectSchema,
  RenameInput,
  RenameSchema,
  SetIconInput,
  SetIconSchema,
} from "./dto";

@ApiTags("projects")
@ApiSecurity("pat")
@Controller("projects")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @ApiZodResponse(ProjectViewSchema, { isArray: true })
  @Paginated()
  list(@CurrentUser() user: AuthUser, @Query("q") q?: string) {
    return this.projects.list(user.userId, q);
  }

  @Post()
  @ApiZodBody(CreateProjectSchema)
  @ApiZodResponse(ProjectViewSchema, { status: 201 })
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateProjectSchema)) body: CreateProjectInput,
  ) {
    return this.projects.create(user.userId, body.teamId, body.name);
  }

  // Static segment before ":id" so it isn't matched as a project id.
  @Put("environments/:envId")
  @HttpCode(200)
  @ApiZodBody(RenameSchema)
  async renameEnvironment(
    @CurrentUser() user: AuthUser,
    @Param("envId") envId: string,
    @Body(new ZodValidationPipe(RenameSchema)) body: RenameInput,
  ) {
    await this.projects.renameEnvironment(user.userId, envId, body.name);
    return { ok: true };
  }

  @Delete("environments/:envId")
  @HttpCode(200)
  async removeEnvironment(@CurrentUser() user: AuthUser, @Param("envId") envId: string) {
    await this.projects.removeEnvironment(user.userId, envId);
    return { ok: true };
  }

  @Get(":id")
  @ApiZodResponse(ProjectViewSchema)
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.projects.get(user.userId, id);
  }

  @Put(":id")
  @ApiZodBody(RenameSchema)
  @ApiZodResponse(ProjectViewSchema)
  rename(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RenameSchema)) body: RenameInput,
  ) {
    return this.projects.rename(user.userId, id, body.name);
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.projects.remove(user.userId, id);
    return { ok: true };
  }

  /**
   * The project's custom icon as a raw PNG (read-level; 404 when none). Served from our own origin, so it is
   * locked down: a fixed image/png type, nosniff, and a restrictive CSP. The client appends
   * ?v=<iconUpdatedAt> to cache-bust it.
   */
  @Get(":id/icon")
  @Header("X-Content-Type-Options", "nosniff")
  @Header("Content-Security-Policy", "default-src 'none'; sandbox")
  @Header("Cache-Control", "private, max-age=60")
  async getIcon(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<StreamableFile> {
    const icon = await this.projects.getIcon(user.userId, id);
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
    await this.projects.setIcon(user.userId, id, body.data);
    return { ok: true };
  }

  @Delete(":id/icon")
  @RequireScopes("write") // removing a cosmetic icon is a write op, not a destructive admin one
  @HttpCode(200)
  async deleteIcon(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.projects.deleteIcon(user.userId, id);
    return { ok: true };
  }

  @Post(":id/environments")
  @ApiZodBody(CreateEnvironmentSchema)
  @ApiZodResponse(ProjectViewSchema, { status: 201 })
  addEnvironment(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CreateEnvironmentSchema)) body: CreateEnvironmentInput,
  ) {
    return this.projects.addEnvironment(user.userId, id, body.name);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
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
} from "./dto";

@ApiTags("projects")
@ApiSecurity("pat")
@Controller("projects")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @ApiZodResponse(ProjectViewSchema, { isArray: true })
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

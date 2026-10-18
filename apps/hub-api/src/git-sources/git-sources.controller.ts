import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { Paginated } from "../common/pagination.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { GitSourcesService } from "./git-sources.service";
import { CreateGitSourceInput, CreateGitSourceSchema } from "./dto";

@ApiTags("git-sources")
@ApiSecurity("pat")
@Controller("git-sources")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class GitSourcesController {
  constructor(private readonly svc: GitSourcesService) {}

  @Get()
  @Paginated()
  list(@CurrentUser() user: AuthUser, @Query("q") q?: string) {
    return this.svc.list(user.userId, q);
  }

  @Post()
  @ApiZodBody(CreateGitSourceSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateGitSourceSchema)) body: CreateGitSourceInput,
  ) {
    return this.svc.create(user.userId, body);
  }

  @Get(":id/repos")
  repos(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.listRepos(user.userId, id);
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.svc.remove(user.userId, id);
    return { ok: true };
  }
}

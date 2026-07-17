import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiCookieAuth } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { GitSourcesService } from "./git-sources.service";
import { CreateGitSourceInput, CreateGitSourceSchema } from "./dto";

@ApiTags("git-sources")
@ApiCookieAuth("session")
@Controller("git-sources")
@UseGuards(JwtAuthGuard)
export class GitSourcesController {
  constructor(private readonly svc: GitSourcesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user.userId);
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

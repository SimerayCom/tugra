import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { Paginated } from "../common/pagination.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { GitSourcesService } from "./git-sources.service";
import { GithubManifestService } from "./github-manifest.service";
import {
  CreateGitSourceInput, CreateGitSourceSchema, GitBranchesQuerySchema, GitSourceSharingInput, GitSourceSharingSchema,
  GithubInstallationInput, GithubInstallationSchema, GithubManifestCompleteInput, GithubManifestCompleteSchema, GithubManifestStartInput, GithubManifestStartSchema,
} from "./dto";

@ApiTags("git-sources")
@ApiSecurity("pat")
@Controller("git-sources")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class GitSourcesController {
  constructor(private readonly svc: GitSourcesService, private readonly manifest: GithubManifestService) {}

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

  /** "Connect GitHub", step 1: the manifest (name, permissions, webhook URL, redirect pages) for the browser to POST. */
  @Post("github/manifest")
  @HttpCode(200)
  @ApiZodBody(GithubManifestStartSchema)
  manifestStart(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(GithubManifestStartSchema)) body: GithubManifestStartInput) {
    return this.manifest.start(user.userId, body);
  }

  /** Step 2: GitHub sent the browser back with a code; store the new App's credentials and return the install link. */
  @Post("github/manifest/complete")
  @HttpCode(200)
  @ApiZodBody(GithubManifestCompleteSchema)
  manifestComplete(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(GithubManifestCompleteSchema)) body: GithubManifestCompleteInput) {
    return this.manifest.complete(user.userId, body);
  }

  /** Step 3: GitHub sent the browser back from the install page; record the installation. */
  @Post("github/installation")
  @HttpCode(200)
  @ApiZodBody(GithubInstallationSchema)
  manifestInstallation(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(GithubInstallationSchema)) body: GithubInstallationInput) {
    return this.manifest.captureInstallation(user.userId, body);
  }

  /** Install an existing GitHub App source on another account or organization. */
  @Post(":id/installations")
  @HttpCode(200)
  installations(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.manifest.startInstall(user.userId, id);
  }

  @Patch(":id/sharing")
  @RequireScopes("admin")
  @ApiZodBody(GitSourceSharingSchema)
  sharing(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(GitSourceSharingSchema)) body: GitSourceSharingInput,
  ) {
    return this.svc.setSharing(user.userId, id, body.sharedAllTeams);
  }

  @Get(":id/repos")
  repos(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.listRepos(user.userId, id);
  }

  @Get(":id/branches")
  branches(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(GitBranchesQuerySchema)) q: { repo: string },
  ) {
    return this.svc.listBranches(user.userId, id, q.repo);
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.svc.remove(user.userId, id);
    return { ok: true };
  }
}

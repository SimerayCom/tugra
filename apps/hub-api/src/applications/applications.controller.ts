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
} from "@nestjs/common";
import { concat, EMPTY, from, map, mergeMap, type Observable } from "rxjs";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { SetTagsSchema, type SetTagsInput } from "../common/tags";
import { ApplicationsService } from "./applications.service";
import {
  CreateAppInput,
  CreateAppSchema,
  DeployInput,
  DeploySchema,
  FromTemplateInput,
  FromTemplateSchema,
  PreviewConfigInput,
  PreviewConfigSchema,
  RenameInput,
  RenameSchema,
  SetBuildArgsInput,
  SetBuildArgsSchema,
  SetDockerOptionsInput,
  SetDockerOptionsSchema,
  SetCredentialsInput,
  SetCredentialsSchema,
  SetEnvInput,
  SetEnvSchema,
  SetDomainInput,
  SetDomainSchema,
  ExposeInput,
  ExposeSchema,
  SetDomainOptionsInput,
  SetDomainOptionsSchema,
  SetEnvironmentInput,
  SetEnvironmentSchema,
  SetLimitsInput,
  SetLimitsSchema,
  SetHealthCheckInput,
  SetHealthCheckSchema,
  SetBuildConfigInput,
  SetBuildConfigSchema,
  SetDeploySettingsInput,
  SetDeploySettingsSchema,
  SetVolumesInput,
  SetVolumesSchema,
} from "./dto";

@Controller("apps")
@UseGuards(ApiAuthGuard)
export class ApplicationsController {
  constructor(private readonly apps: ApplicationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.apps.list(user.userId);
  }

  // NOTE: must precede `@Get(":id")` so "templates" isn't matched as an app id.
  @Get("templates")
  listTemplates() {
    return this.apps.listTemplates();
  }

  // Likewise precedes `@Get(":id")` — central domain + live SSL overview.
  @Get("domains")
  listDomains(@CurrentUser() user: AuthUser) {
    return this.apps.listDomains(user.userId);
  }

  @Post("templates/:slug")
  @HttpCode(201)
  fromTemplate(
    @CurrentUser() user: AuthUser,
    @Param("slug") slug: string,
    @Body(new ZodValidationPipe(FromTemplateSchema)) body: FromTemplateInput,
  ) {
    return this.apps.createFromTemplate(user.userId, slug, body);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateAppSchema)) body: CreateAppInput,
  ) {
    return this.apps.create(user.userId, body);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.get(user.userId, id);
  }

  @Get(":id/deployments")
  deployments(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.deployments(user.userId, id);
  }

  @Post(":id/deployments/:depId/analyze")
  @HttpCode(200)
  analyzeDeployment(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("depId") depId: string,
  ) {
    return this.apps.analyzeDeployment(user.userId, id, depId);
  }

  @Get(":id/containers")
  listContainers(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.listContainers(user.userId, id);
  }

  @Get(":id/logs")
  appLogs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("tail") tail?: string,
  ) {
    return this.apps.appLogs(user.userId, id, tail ? Number(tail) : undefined);
  }

  /** Per-container metrics history for the app's Metrics tab (read-level). */
  @Get(":id/metrics/containers")
  containerMetrics(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("range") range?: string,
  ) {
    return this.apps.containerMetrics(user.userId, id, range);
  }

  /** Live build-log stream (SSE). Completes when no deploy is active. */
  @Sse(":id/deployments/stream")
  streamLogs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
  ): Observable<MessageEvent> {
    return from(this.apps.streamLogs(user.userId, id)).pipe(
      mergeMap((sub) => (sub ? concat(from(sub.replay), sub.live) : EMPTY)),
      map((event) => ({ data: JSON.stringify(event) }) as MessageEvent),
    );
  }

  /**
   * Live container-log follow (SSE). Writer-only; `container` picks a compose service. The handler
   * is async and AWAITS the authz/resolution so a rejection surfaces as a real HTTP status (403/400/
   * 503) — NestJS only starts the SSE stream after the handler promise resolves.
   */
  @Sse(":id/logs/stream")
  async streamContainerLogs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("container") container?: string,
    @Query("tail") tail?: string,
    @Query("follow") follow?: string,
    @Query("since") since?: string,
    @Query("search") search?: string,
  ): Promise<Observable<MessageEvent>> {
    const stream = await this.apps.streamContainerLogs(user.userId, id, {
      container,
      tail: tail ? Number(tail) : undefined,
      follow: follow !== "0",
      since,
      search,
    });
    return stream.pipe(map((event) => ({ data: JSON.stringify(event) }) as MessageEvent));
  }

  /** One-shot log export (writer-only) — returns the collected logs as a downloadable text file. */
  @Get(":id/logs/download")
  @Header("Content-Type", "text/plain; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="container.log"')
  downloadLogs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("container") container?: string,
    @Query("tail") tail?: string,
    @Query("since") since?: string,
  ): Promise<string> {
    return this.apps.downloadLogs(user.userId, id, {
      container,
      tail: tail ? Number(tail) : undefined,
      since,
    });
  }

  @Post(":id/deploy")
  @HttpCode(200)
  deploy(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(DeploySchema)) body: DeployInput,
  ) {
    return this.apps.deploy(user.userId, id, body);
  }

  @Get(":id/env")
  getEnv(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.getEnv(user.userId, id);
  }

  @Put(":id/env")
  @HttpCode(200)
  async setEnv(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetEnvSchema)) body: SetEnvInput,
  ) {
    await this.apps.setEnv(user.userId, id, body.env);
    return { ok: true };
  }

  @Get(":id/build-args")
  getBuildArgs(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.getBuildArgs(user.userId, id);
  }

  @Put(":id/name")
  @HttpCode(200)
  async rename(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RenameSchema)) body: RenameInput,
  ) {
    await this.apps.rename(user.userId, id, body.name);
    return { ok: true };
  }

  @Put(":id/docker-options")
  @HttpCode(200)
  async setDockerOptions(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetDockerOptionsSchema)) body: SetDockerOptionsInput,
  ) {
    await this.apps.setDockerOptions(user.userId, id, body.dockerOptions);
    return { ok: true };
  }

  @Put(":id/build-args")
  @HttpCode(200)
  async setBuildArgs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetBuildArgsSchema)) body: SetBuildArgsInput,
  ) {
    await this.apps.setBuildArgs(user.userId, id, body.buildArgs);
    return { ok: true };
  }

  @Put(":id/limits")
  @HttpCode(200)
  async setLimits(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetLimitsSchema)) body: SetLimitsInput,
  ) {
    await this.apps.setLimits(user.userId, id, body);
    return { ok: true };
  }

  @Put(":id/health-check")
  @HttpCode(200)
  async setHealthCheck(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetHealthCheckSchema)) body: SetHealthCheckInput,
  ) {
    await this.apps.setHealthCheck(user.userId, id, body);
    return { ok: true };
  }

  @Put(":id/build-config")
  @HttpCode(200)
  async setBuildConfig(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetBuildConfigSchema)) body: SetBuildConfigInput,
  ) {
    await this.apps.setBuildConfig(user.userId, id, body);
    return { ok: true };
  }

  @Put(":id/deploy-settings")
  @HttpCode(200)
  async setDeploySettings(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetDeploySettingsSchema)) body: SetDeploySettingsInput,
  ) {
    await this.apps.setDeploySettings(user.userId, id, body);
    return { ok: true };
  }

  @Put(":id/volumes")
  @HttpCode(200)
  async setVolumes(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetVolumesSchema)) body: SetVolumesInput,
  ) {
    await this.apps.setVolumes(user.userId, id, body.volumes);
    return { ok: true };
  }

  @Put(":id/credentials")
  @HttpCode(200)
  async setCredentials(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetCredentialsSchema)) body: SetCredentialsInput,
  ) {
    await this.apps.setCredentials(user.userId, id, body);
    return { ok: true };
  }

  @Put(":id/environment")
  @HttpCode(200)
  async setEnvironment(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetEnvironmentSchema)) body: SetEnvironmentInput,
  ) {
    await this.apps.setEnvironment(user.userId, id, body.environmentId);
    return { ok: true };
  }

  @Put(":id/domain")
  @HttpCode(200)
  async setDomain(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetDomainSchema)) body: SetDomainInput,
  ) {
    await this.apps.setDomain(user.userId, id, body.domain);
    return { ok: true };
  }

  @Put(":id/domain-options")
  @HttpCode(200)
  async setDomainOptions(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetDomainOptionsSchema)) body: SetDomainOptionsInput,
  ) {
    await this.apps.setDomainOptions(user.userId, id, body);
    return { ok: true };
  }

  @Put(":id/expose")
  @HttpCode(200)
  expose(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ExposeSchema)) body: ExposeInput,
  ) {
    return this.apps.expose(user.userId, id, body);
  }

  @Put(":id/tags")
  @HttpCode(200)
  async setTags(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetTagsSchema)) body: SetTagsInput,
  ) {
    await this.apps.setTags(user.userId, id, body.tags);
    return { ok: true };
  }

  @Get(":id/previews")
  listPreviews(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.listPreviews(user.userId, id);
  }

  @Put(":id/preview-config")
  @HttpCode(200)
  async setPreviewEnabled(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(PreviewConfigSchema)) body: PreviewConfigInput,
  ) {
    await this.apps.setPreviewEnabled(user.userId, id, body.enabled);
    return { ok: true };
  }

  @Delete(":id/previews/:previewId")
  @HttpCode(200)
  async deletePreview(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("previewId") previewId: string,
  ) {
    await this.apps.deletePreview(user.userId, id, previewId);
    return { ok: true };
  }

  @Post(":id/webhook/regenerate")
  @HttpCode(200)
  regenerateWebhook(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.regenerateWebhook(user.userId, id);
  }

  @Post(":id/rollback/:deploymentId")
  @HttpCode(200)
  rollback(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("deploymentId") deploymentId: string,
  ) {
    return this.apps.rollback(user.userId, id, deploymentId);
  }

  @Post(":id/stop")
  @HttpCode(200)
  async stop(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.apps.stop(user.userId, id);
    return { ok: true };
  }

  @Post(":id/start")
  @HttpCode(200)
  async start(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.apps.start(user.userId, id);
    return { ok: true };
  }

  @Post(":id/restart")
  @HttpCode(200)
  async restart(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.apps.restart(user.userId, id);
    return { ok: true };
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.apps.remove(user.userId, id);
    return { ok: true };
  }
}

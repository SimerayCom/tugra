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
import { concat, EMPTY, from, map, mergeMap, type Observable } from "rxjs";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { parseDate, str } from "../audit/audit.controller";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { RedactSecretsInterceptor } from "../api-tokens/redact-secrets.interceptor";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { SetTagsSchema, type SetTagsInput } from "../common/tags";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ApplicationsService, AppViewSchema, DomainViewSchema } from "./applications.service";
import { ContainerLogStreamGuard } from "./log-stream.guard";
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
  AutoSetupDomainSchema,
  AutoSetupDomainInput,
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
  SetClusterConfigInput,
  SetClusterConfigSchema,
  SetDeploySettingsInput,
  SetDeploySettingsSchema,
  SetPlacementInput,
  SetPlacementSchema,
  SetVolumesInput,
  SetVolumesSchema,
} from "./dto";

@ApiTags("apps")
@ApiSecurity("pat")
@Controller("apps")
@UseGuards(ApiAuthGuard, ScopesGuard)
@UseInterceptors(new RedactSecretsInterceptor(["webhookSecret"]))
export class ApplicationsController {
  constructor(private readonly apps: ApplicationsService) {}

  @Get()
  @ApiZodResponse(AppViewSchema, { isArray: true })
  list(@CurrentUser() user: AuthUser, @Query("q") q?: string) {
    return this.apps.list(user.userId, q);
  }

  // NOTE: must precede `@Get(":id")` so "templates" isn't matched as an app id.
  @Get("templates")
  listTemplates() {
    return this.apps.listTemplates();
  }

  // Install-form manifest for one template (typed fields + exposure; secret values / raw compose never
  // leak — pass ?serverId= to get the compose when you can write to that server's team). Also precedes
  // `@Get(":id")` (its first segment is the literal "templates").
  @Get("templates/:slug")
  templateManifest(
    @CurrentUser() user: AuthUser,
    @Param("slug") slug: string,
    @Query("serverId") serverId?: string,
  ) {
    return this.apps.getTemplateManifest(user.userId, slug, serverId);
  }

  // Likewise precedes `@Get(":id")` — central domain + live SSL overview.
  @Get("domains")
  @ApiZodResponse(DomainViewSchema, { isArray: true })
  listDomains(@CurrentUser() user: AuthUser, @Query("q") q?: string) {
    return this.apps.listDomains(user.userId, q);
  }

  @Post("templates/:slug")
  @HttpCode(201)
  @ApiZodBody(FromTemplateSchema)
  @ApiZodResponse(AppViewSchema, { status: 201 })
  fromTemplate(
    @CurrentUser() user: AuthUser,
    @Param("slug") slug: string,
    @Body(new ZodValidationPipe(FromTemplateSchema)) body: FromTemplateInput,
  ) {
    return this.apps.createFromTemplate(user.userId, slug, body);
  }

  @Post()
  @ApiZodBody(CreateAppSchema)
  @ApiZodResponse(AppViewSchema, { status: 201 })
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateAppSchema)) body: CreateAppInput,
  ) {
    return this.apps.create(user.userId, body);
  }

  @Get(":id")
  @ApiZodResponse(AppViewSchema)
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.get(user.userId, id);
  }

  @Get(":id/deployments")
  @RequireScopes("read:secrets") // rows carry raw build/deploy logs (may contain secrets)
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

  @Get(":id/cluster-status")
  clusterStatus(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.clusterStatus(user.userId, id);
  }

  @Get(":id/logs")
  @RequireScopes("read:secrets") // container logs may contain secrets
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
  @RequireScopes("read:secrets") // live build logs may contain secrets
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
  @RequireScopes("read:secrets") // live container logs may contain secrets
  @UseGuards(ContainerLogStreamGuard) // authorize BEFORE @Sse commits a 200 stream (real 403/503)
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
  @RequireScopes("read:secrets") // exported logs may contain secrets
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
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(DeploySchema)
  deploy(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(DeploySchema)) body: DeployInput,
  ) {
    return this.apps.deploy(user.userId, id, body);
  }

  @Get(":id/env")
  @RequireScopes("read:secrets")
  getEnv(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.getEnv(user.userId, id);
  }

  @Put(":id/env")
  @HttpCode(200)
  @ApiZodBody(SetEnvSchema)
  async setEnv(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetEnvSchema)) body: SetEnvInput,
  ) {
    await this.apps.setEnv(user.userId, id, body.env);
    return { ok: true };
  }

  @Get(":id/build-args")
  @RequireScopes("read:secrets")
  getBuildArgs(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.getBuildArgs(user.userId, id);
  }

  @Put(":id/name")
  @HttpCode(200)
  @ApiZodBody(RenameSchema)
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
  @ApiZodBody(SetDockerOptionsSchema)
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
  @ApiZodBody(SetBuildArgsSchema)
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
  @ApiZodBody(SetLimitsSchema)
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
  @ApiZodBody(SetHealthCheckSchema)
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
  @ApiZodBody(SetBuildConfigSchema)
  async setBuildConfig(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetBuildConfigSchema)) body: SetBuildConfigInput,
  ) {
    await this.apps.setBuildConfig(user.userId, id, body);
    return { ok: true };
  }

  @Put(":id/cluster-config")
  @HttpCode(200)
  @ApiZodBody(SetClusterConfigSchema)
  async setClusterConfig(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetClusterConfigSchema)) body: SetClusterConfigInput,
  ) {
    await this.apps.setClusterConfig(user.userId, id, body);
    return { ok: true };
  }

  @Put(":id/deploy-settings")
  @HttpCode(200)
  @ApiZodBody(SetDeploySettingsSchema)
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
  @ApiZodBody(SetVolumesSchema)
  async setVolumes(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetVolumesSchema)) body: SetVolumesInput,
  ) {
    await this.apps.setVolumes(user.userId, id, body.volumes);
    return { ok: true };
  }

  @Put(":id/placement")
  @HttpCode(200)
  @ApiZodBody(SetPlacementSchema)
  async setPlacement(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetPlacementSchema)) body: SetPlacementInput,
  ) {
    await this.apps.setPlacement(user.userId, id, body);
    return { ok: true };
  }

  @Put(":id/credentials")
  @HttpCode(200)
  @ApiZodBody(SetCredentialsSchema)
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
  @ApiZodBody(SetEnvironmentSchema)
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
  @ApiZodBody(SetDomainSchema)
  async setDomain(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetDomainSchema)) body: SetDomainInput,
  ) {
    await this.apps.setDomain(user.userId, id, body.domain);
    return { ok: true };
  }

  // One-click Cloudflare DNS auto-setup for a custom domain: create the apex A (+AAAA) + www CNAME records and
  // wire the app's domain/HTTPS. `dryRun` returns the plan only. deploy scope (it both mutates DNS and the app).
  @Post(":id/domain/auto-setup")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiZodBody(AutoSetupDomainSchema)
  autoSetupDomain(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(AutoSetupDomainSchema)) body: AutoSetupDomainInput,
  ) {
    return this.apps.autoSetupDomain(user.userId, id, body);
  }

  // The copy-paste DNS records an operator should create by hand (manual fallback when not using Cloudflare).
  // Read-only + advisory (apps:config in the service): no provider call, just the app's target IP(s) + the host.
  @Get(":id/domain/manual-records")
  manualDomainRecords(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("domain") domain: string,
    @Query("includeWww") includeWww?: string,
  ) {
    return this.apps.manualDomainRecords(user.userId, id, { domain, includeWww: includeWww !== "false" });
  }

  // Re-check an auto-setup domain resolves to the app (real public-DNS lookup) + refresh its stored status.
  @Post(":id/domain/verify")
  @HttpCode(200)
  @RequireScopes("read")
  verifyDomain(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query("hostname") hostname?: string) {
    return this.apps.verifyDomain(user.userId, id, hostname || undefined);
  }

  // Tear down the Cloudflare records Tugra created for this app's domain(s). Destructive → deploy scope.
  @Delete(":id/domain/dns")
  @HttpCode(200)
  @RequireScopes("deploy")
  cleanupDomainDns(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query("hostname") hostname?: string) {
    return this.apps.cleanupDomainDns(user.userId, id, hostname || undefined);
  }

  // This app's audit history (every actor; apps:config gates it). Optional ?action=&from=&to=&cursor=.
  @Get(":id/audit")
  listAudit(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("cursor") cursor?: string,
    @Query("action") action?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.apps.listAudit(user.userId, id, { cursor: str(cursor), action: str(action), from: parseDate(from), to: parseDate(to) });
  }

  @Put(":id/domain-options")
  @HttpCode(200)
  @ApiZodBody(SetDomainOptionsSchema)
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
  @ApiZodBody(ExposeSchema)
  @ApiZodResponse(AppViewSchema)
  expose(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ExposeSchema)) body: ExposeInput,
  ) {
    return this.apps.expose(user.userId, id, body);
  }

  @Put(":id/tags")
  @HttpCode(200)
  @ApiZodBody(SetTagsSchema)
  async setTags(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetTagsSchema)) body: SetTagsInput,
  ) {
    await this.apps.setTags(user.userId, id, body.tags);
    return { ok: true };
  }

  @Get(":id/previews")
  @ApiZodResponse(AppViewSchema, { isArray: true })
  listPreviews(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.listPreviews(user.userId, id);
  }

  @Put(":id/preview-config")
  @HttpCode(200)
  @ApiZodBody(PreviewConfigSchema)
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
  @ApiZodResponse(AppViewSchema)
  regenerateWebhook(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.regenerateWebhook(user.userId, id);
  }

  @Post(":id/rollback/:deploymentId")
  @RequireScopes("deploy")
  @HttpCode(200)
  rollback(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("deploymentId") deploymentId: string,
  ) {
    return this.apps.rollback(user.userId, id, deploymentId);
  }

  @Post(":id/stop")
  @RequireScopes("deploy")
  @HttpCode(200)
  async stop(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.apps.stop(user.userId, id);
    return { ok: true };
  }

  @Post(":id/start")
  @RequireScopes("deploy")
  @HttpCode(200)
  async start(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.apps.start(user.userId, id);
    return { ok: true };
  }

  @Post(":id/restart")
  @RequireScopes("deploy")
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

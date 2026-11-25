import { ReadCoalescer } from "../common/read-coalescer";
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
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CleanupService } from "./cleanup.service";
import { GpuInventoryService } from "./gpu-inventory.service";
import { GpuReportSchema } from "./gpu-inventory";
import { ServerScanService } from "./server-scan.service";
import { ScanViewSchema } from "./server-scan";
import { PatchService } from "./patch.service";
import { RebootService } from "./reboot.service";
import { LogDrainService } from "./log-drain.service";
import { ProxyOpsService } from "./proxy-ops.service";
import { ContainerOpsService } from "./container-ops.service";
import { ContainerLogStreamGuard } from "./container-log-stream.guard";
import {
  CleanupConfigInput,
  CleanupConfigSchema,
  ContainerActionInput,
  ContainerActionSchema,
  CreateLogDrainInput,
  CreateLogDrainSchema,
  PatchApplyInput,
  PatchApplyBodySchema,
  PatchApplySchema,
  RebootPreviewSchema,
  RebootRequestInput,
  RebootRequestSchema,
  RebootStatusSchema,
  RebootViewSchema,
  SetProxyDynamicConfigInput,
  SetProxyDynamicConfigSchema,
  SetTrafficAnalyticsInput,
  SetTrafficAnalyticsSchema,
  TrafficAnalyticsStateSchema,
  UpdateLogDrainInput,
  UpdateLogDrainSchema,
} from "./dto";

@ApiTags("servers")
@ApiSecurity("pat")
@Controller("servers/:id")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ServerOpsController {
  constructor(
    private readonly cleanup: CleanupService,
    private readonly gpus: GpuInventoryService,
    private readonly patch: PatchService,
    private readonly reboot: RebootService,
    private readonly logDrains: LogDrainService,
    private readonly proxy: ProxyOpsService,
    private readonly containerOps: ContainerOpsService,
    private readonly scans: ServerScanService,
    private readonly coalescer: ReadCoalescer,
  ) {}

  /**
   * Live logs of ANY container on this host (from the Containers tab). Writer-only; logs may contain
   * secrets. The guard authorizes BEFORE @Sse commits a 200 stream, and the container is validated
   * against the host's live inventory so only a container actually on this server can be targeted.
   */
  @Sse("containers/logs/stream")
  @RequireScopes("read:secrets")
  @UseGuards(ContainerLogStreamGuard)
  async containerLogs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("container") container: string,
    @Query("tail") tail?: string,
    @Query("follow") follow?: string,
    @Query("since") since?: string,
    @Query("search") search?: string,
  ): Promise<Observable<MessageEvent>> {
    const stream = await this.containerOps.streamLogs(user.userId, id, container, {
      tail: tail ? Number(tail) : undefined,
      follow: follow !== "0",
      since,
      search,
    });
    return stream.pipe(map((event) => ({ data: JSON.stringify(event) }) as MessageEvent));
  }

  /** Host-wide container list INCLUDING stopped ones (so the tab can offer Start). Writer-level service-side. */
  @Get("containers/all")
  listContainers(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.coalescer.run(`ops:containers:${user.userId}:${id}`, () => this.containerOps.list(user.userId, id));
  }

  /** Lifecycle action on a container (start / restart / stop / remove). Writer-only; strong guards service-side. */
  @Post("containers/action")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(ContainerActionSchema)
  async containerAction(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ContainerActionSchema)) body: ContainerActionInput,
  ) {
    await this.containerOps.action(user.userId, id, body.container, body.action, body.confirmName);
    return { ok: true };
  }

  /** One-shot container-log export (writer-only) — a downloadable text file. */
  @Get("containers/logs/download")
  @RequireScopes("read:secrets")
  @Header("Content-Type", "text/plain; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="container.log"')
  downloadContainerLogs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("container") container: string,
    @Query("tail") tail?: string,
    @Query("since") since?: string,
  ): Promise<string> {
    return this.containerOps.downloadLogs(user.userId, id, container, {
      tail: tail ? Number(tail) : undefined,
      since,
    });
  }

  @Get("proxy")
  proxyStatus(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.proxy.status(user.userId, id);
  }

  @Post("proxy/start")
  @RequireScopes("deploy")
  @HttpCode(200)
  proxyStart(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.proxy.start(user.userId, id);
  }

  @Post("proxy/stop")
  @RequireScopes("deploy")
  @HttpCode(200)
  proxyStop(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.proxy.stop(user.userId, id);
  }

  @Post("proxy/restart")
  @RequireScopes("deploy")
  @HttpCode(200)
  proxyRestart(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.proxy.restart(user.userId, id);
  }

  @Get("proxy/logs")
  proxyLogs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("tail") tail?: string,
  ) {
    return this.proxy.logs(user.userId, id, tail ? Number(tail) : undefined);
  }

  // Operator-authored Traefik dynamic-config files (Coolify "Proxy > Dynamic Configurations" parity).
  @Get("proxy/dynamic")
  proxyDynamicList(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.proxy.listDynamicConfigs(user.userId, id);
  }

  @Put("proxy/dynamic/:name")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(SetProxyDynamicConfigSchema)
  async proxyDynamicPut(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("name") name: string,
    @Body(new ZodValidationPipe(SetProxyDynamicConfigSchema)) body: SetProxyDynamicConfigInput,
  ) {
    await this.proxy.putDynamicConfig(user.userId, id, name, body.content);
    return { ok: true };
  }

  @Delete("proxy/dynamic/:name")
  @RequireScopes("deploy")
  @HttpCode(200)
  async proxyDynamicDelete(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("name") name: string) {
    await this.proxy.deleteDynamicConfig(user.userId, id, name);
    return { ok: true };
  }

  // Per-server Traffic Analytics (proxy access log) toggle — servers:manage like the other server settings;
  // re-applies the proxy so it takes effect now (see ProxyOpsService.setTrafficAnalytics).
  @Put("traffic-analytics")
  @HttpCode(200)
  @ApiZodBody(SetTrafficAnalyticsSchema)
  @ApiZodResponse(TrafficAnalyticsStateSchema)
  setTrafficAnalytics(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetTrafficAnalyticsSchema)) body: SetTrafficAnalyticsInput,
  ) {
    return this.proxy.setTrafficAnalytics(user.userId, id, body.enabled);
  }

  @Get("log-drains")
  listLogDrains(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.logDrains.list(user.userId, id);
  }

  // App-scoped drains shipping logs off this server (summary only: no endpoint/options/containers/token).
  @Get("log-drains/apps")
  @RequireScopes("read:secrets")
  listAppLogDrains(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.logDrains.listApps(user.userId, id);
  }

  @Post("log-drains")
  @ApiZodBody(CreateLogDrainSchema)
  createLogDrain(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CreateLogDrainSchema)) body: CreateLogDrainInput,
  ) {
    return this.logDrains.create(user.userId, id, body);
  }

  @Put("log-drains/:drainId")
  @HttpCode(200)
  @ApiZodBody(UpdateLogDrainSchema)
  updateLogDrain(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("drainId") drainId: string,
    @Body(new ZodValidationPipe(UpdateLogDrainSchema)) body: UpdateLogDrainInput,
  ) {
    return this.logDrains.update(user.userId, drainId, body, id);
  }

  @Delete("log-drains/:drainId")
  @HttpCode(200)
  async deleteLogDrain(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("drainId") drainId: string) {
    await this.logDrains.remove(user.userId, drainId, id);
    return { ok: true };
  }

  // deploy-tier: the check now runs a PRIVILEGED host `apt-get update` (host-exec), so it must not be
  // reachable by a read-only PAT — it is a host mutation surface, not a plain read.
  @Get("updates")
  @RequireScopes("deploy")
  checkUpdates(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.patch.checkUpdates(user.userId, id);
  }

  @Post("updates/apply")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(PatchApplySchema, { required: false })
  upgradeAll(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    // The body is optional (older callers send none): scope defaults to "all".
    @Body(new ZodValidationPipe(PatchApplyBodySchema)) body: PatchApplyInput,
  ) {
    return this.patch.upgradeAll(user.userId, id, body.scope);
  }

  @Post("updates/apply/:pkg")
  @RequireScopes("deploy")
  @HttpCode(200)
  upgradeOne(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("pkg") pkg: string) {
    return this.patch.upgradeOne(user.userId, id, pkg);
  }

  /** Install one phased (gradually rolled out) apt package right now. */
  @Post("updates/apply/:pkg/phased")
  @RequireScopes("deploy")
  @HttpCode(200)
  upgradePhased(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("pkg") pkg: string) {
    return this.patch.upgradePhased(user.userId, id, pkg);
  }

  /** Live patch-log stream (SSE). Completes when no patch run is active. */
  @Sse("updates/stream")
  streamLogs(@CurrentUser() user: AuthUser, @Param("id") id: string): Observable<MessageEvent> {
    return from(this.patch.streamLogs(user.userId, id)).pipe(
      mergeMap((sub) => (sub ? concat(from(sub.replay), sub.live) : EMPTY)),
      map((event) => ({ data: JSON.stringify(event) }) as MessageEvent),
    );
  }

  // ── Reboot server. Never automatic: needs the server's name typed as confirmation. Same gate as patching: team
  // permission servers:ops, `deploy` PAT scope for the mutating calls. DELETE cancels a SCHEDULED reboot only.
  @Get("reboot")
  @ApiZodResponse(RebootStatusSchema)
  rebootStatus(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.reboot.status(user.userId, id);
  }

  /** What a reboot would take down (counts), for the confirmation dialog. */
  @Get("reboot/preview")
  @ApiZodResponse(RebootPreviewSchema)
  rebootPreview(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.reboot.preview(user.userId, id);
  }

  @Post("reboot")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(RebootRequestSchema)
  @ApiZodResponse(RebootViewSchema)
  requestReboot(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RebootRequestSchema)) body: RebootRequestInput,
  ) {
    return this.reboot.request(user.userId, id, body);
  }

  @Delete("reboot")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(RebootViewSchema)
  cancelReboot(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.reboot.cancel(user.userId, id);
  }

  @Post("cleanup")
  @RequireScopes("deploy")
  @HttpCode(200)
  cleanupNow(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.cleanup.cleanupNow(user.userId, id);
  }

  // Read-only disk-usage breakdown (docker system df); any team member, no special scope — like proxy status.
  @Get("disk-usage")
  diskUsage(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.cleanup.diskUsage(user.userId, id);
  }

  // Persisted GPU detection snapshot (membership only, no agent traffic) — like disk-usage. NULL inventory = unknown.
  @Get("gpus")
  @ApiZodResponse(GpuReportSchema)
  getGpus(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.gpus.getReport(user.userId, id);
  }

  // Re-run the GPU probe on the host (writers; starts a short-lived unprivileged helper container).
  @Post("gpus/refresh")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(GpuReportSchema)
  refreshGpus(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.gpus.refresh(user.userId, id);
  }

  // Stored "What runs on this server" report (membership only, no agent traffic). `report: null` = never scanned.
  @Get("scan")
  @ApiZodResponse(ScanViewSchema)
  getScan(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.scans.getView(user.userId, id);
  }

  // Run the read-only scan now (writers; starts a short-lived read-only helper container, changes nothing on the host).
  @Post("scan")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(ScanViewSchema)
  runScan(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.scans.run(user.userId, id);
  }

  @Put("cleanup-config")
  @HttpCode(200)
  @ApiZodBody(CleanupConfigSchema)
  async setConfig(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CleanupConfigSchema)) body: CleanupConfigInput,
  ) {
    await this.cleanup.setConfig(user.userId, id, body);
    return { ok: true };
  }
}

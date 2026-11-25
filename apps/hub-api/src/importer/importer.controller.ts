import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { hubBaseUrl, publicUrlFrom, type ReqLike } from "../common/hub-url";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ImporterService } from "./importer.service";
import { ImportExecutorService } from "./import-executor.service";
import { VxService } from "./volume-stream/vx.service";
import { VxDiskCheckBodySchema, VxExcludeBodySchema, type VxDiskCheckBody, type VxExcludeBody } from "./volume-stream/vx.dto";
import {
  ImportConnectSchema,
  type ImportConnectInput,
  ImportConnectAgentSchema,
  type ImportConnectAgentInput,
  ImportHostLinkSchema,
  type ImportHostLinkInput,
  ImportTestSchema,
  type ImportTestInput,
  ImportPlanRequestSchema,
  type ImportPlanRequestInput,
  ImportApplySchema,
  type ImportApplyInput,
  ImportRemapEnvSchema,
  type ImportRemapEnvInput,
  ImportGitLinksSchema,
  type ImportGitLinksInput,
  ImportGitRelinkSchema,
  type ImportGitRelinkInput,
  ImportServicesPreviewSchema,
  type ImportServicesPreviewInput,
  ImportMappingResolveSchema,
  type ImportMappingResolveInput,
  ImportMappingPutSchema,
  type ImportMappingPutInput,
} from "./dto";
import { ImportGitLinksService } from "./import-git-links.service";
import { EgressIpService } from "./egress-ip.service";
import { ImportSettingsService } from "./settings/import-settings.service";
import { ImportSettingsApplySchema, ImportSettingsPreviewSchema, type ImportSettingsApplyInput, type ImportSettingsPreviewInput } from "./settings/settings.dto";

@ApiTags("import")
@ApiSecurity("pat")
@Controller("import")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ImporterController {
  constructor(
    private readonly importer: ImporterService,
    private readonly executor: ImportExecutorService,
    private readonly gitLinks: ImportGitLinksService,
    private readonly vx: VxService,
    private readonly egress: EgressIpService,
    private readonly settings: ImportSettingsService,
  ) {}

  /**
   * The hub's public egress IP for the import wizard ("add this address to Coolify's Allowed IPs"). Operator override
   * `IMPORT_EGRESS_IP`, else the hub's own server record, else `{ ip: null, source: "unknown" }`. No outbound probe.
   * Read-only and cached; the address is not a secret (the source sees it on every request).
   */
  @Get("egress-ip")
  egressIp() {
    return this.egress.resolve();
  }

  /** Connect an external source PaaS (Coolify): verify reachability + store an encrypted, expiring session. */
  @Post("connect")
  @RequireScopes("write")
  @ApiZodBody(ImportConnectSchema)
  connect(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ImportConnectSchema)) body: ImportConnectInput,
  ) {
    return this.importer.connect(user.userId, body);
  }

  /**
   * Connect Coolify through the agent on the Coolify host: no token. One full read-only read of Coolify's own database now, then an
   * encrypted, expiring session whose token column is empty. Owner/admin of the server's team and the server's opt-in are checked in
   * the service. `write` scope (it reads that host's database through its agent).
   */
  @Post("connect-agent")
  @RequireScopes("write")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiZodBody(ImportConnectAgentSchema)
  connectAgent(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ImportConnectAgentSchema)) body: ImportConnectAgentInput,
  ) {
    return this.importer.connectAgent(user.userId, body);
  }

  /**
   * The connection test: reachable, the source team's name, how many apps/databases the token sees and whether it has
   * `read:sensitive`. Nothing is stored. It sends the token to the source exactly like connect, so it needs the same
   * `write` scope and the team's `apps:config` permission (checked in the service).
   */
  @Post("test")
  @RequireScopes("write")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiZodBody(ImportTestSchema)
  test(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ImportTestSchema)) body: ImportTestInput,
  ) {
    return this.importer.test(user.userId, body);
  }

  /**
   * Dry-run import plan: preview the Tugra resources an import would create, with per-item risks. No
   * mutation and no secret VALUES (only env keys/counts). The plan reveals env keys, so it requires the
   * `read:secrets` scope — the same scope as the migrator's discover — overriding the POST "write" default.
   * Accepts a local server (`serverId`) to adopt, or a connected remote session (`sessionId`).
   */
  @Post("plan")
  @RequireScopes("read:secrets")
  @ApiZodBody(ImportPlanRequestSchema)
  plan(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ImportPlanRequestSchema)) body: ImportPlanRequestInput,
  ) {
    return this.importer.plan(user.userId, body);
  }

  /**
   * Preview the SERVICE import (Coolify services → stopped compose apps): per service, its verdict, kept/dropped members,
   * variable NAMES (resolved / missing), the domain rows, the volumes with their data class, the config files and what is
   * not carried. Read-only and secret-free (names and fixed reasons only). It reads the source's variables server-side to
   * resolve key names, so it needs `read:secrets` like plan.
   */
  @Post("services/preview")
  @HttpCode(200)
  @RequireScopes("read:secrets")
  @ApiZodBody(ImportServicesPreviewSchema)
  previewServices(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ImportServicesPreviewSchema)) body: ImportServicesPreviewInput,
  ) {
    return this.importer.previewServices(user.userId, body);
  }

  /**
   * Preview the SETTINGS the connected source can carry (notification channels, shared variables, storages, scheduled tasks,
   * server cleanup, tags, members), each entry selectable. Read-only and secret-free: it names what exists and what is
   * missing ("not available via API" per section), never a token, a webhook URL, a key or a variable value. It reads the
   * source's secrets server-side to know what is readable, so it needs `read:secrets` like plan.
   */
  @Post("settings/preview")
  @HttpCode(200)
  @RequireScopes("read:secrets")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiZodBody(ImportSettingsPreviewSchema)
  previewSettings(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ImportSettingsPreviewSchema)) body: ImportSettingsPreviewInput,
  ) {
    return this.settings.preview(user.userId, body);
  }

  /**
   * Carry the selected settings to the session's team. Each write goes through the product's own service, so it needs the
   * matching team permission (`integrations`, `variables`, `apps:config`, `servers:ops`, team admin). Source secrets are read
   * server-side and encrypted at rest; the response has fixed codes only (the one secret is a new backup destination's
   * recovery key, returned once). Invitations are sent only with `confirmInvites: true`.
   */
  @Post("settings/apply")
  @HttpCode(200)
  @RequireScopes("write", "read:secrets")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiZodBody(ImportSettingsApplySchema)
  applySettings(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ImportSettingsApplySchema)) body: ImportSettingsApplyInput,
  ) {
    return this.settings.apply(user.userId, body);
  }

  /** Apply a reviewed plan (bulk-adopts the host's standalone containers). Deploy-tier: it takes over
   *  running workloads. `planHash` must match a fresh re-plan or the apply is refused (409). */
  @Post("apply")
  @RequireScopes("deploy")
  @ApiZodBody(ImportApplySchema)
  apply(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ImportApplySchema)) body: ImportApplyInput,
  ) {
    return this.executor.apply(user.userId, body);
  }

  /** Resolve, for the target server's team, how each git app of the connected source would be linked (repo-visibility
   *  matching against the team's connected GitHub/Gitea sources). Read-only: returns repo names, source names and
   *  fixed status text, never a credential. Powers "connect GitHub once, link N apps" before apply. */
  @Post("git-links")
  @ApiZodBody(ImportGitLinksSchema)
  gitLinksPreview(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ImportGitLinksSchema)) body: ImportGitLinksInput,
  ) {
    return this.gitLinks.list(user.userId, body);
  }

  /** After an import: re-resolve the created apps that are still unlinked and link the covered ones (optionally with an
   *  explicit source pick per ambiguous app). Uses the app Git-source setter, so its team + host checks apply. */
  @Post("operations/:opId/git-links/relink")
  @RequireScopes("deploy")
  @ApiZodBody(ImportGitRelinkSchema)
  relinkGit(
    @CurrentUser() user: AuthUser,
    @Param("opId") opId: string,
    @Body(new ZodValidationPipe(ImportGitRelinkSchema)) body: ImportGitRelinkInput,
  ) {
    return this.gitLinks.relink(user.userId, opId, body);
  }

  /**
   * Authoritative mapping preview: re-plans against the source, then resolves the mapping document against the
   * target server's team — effective names/placement, every conflict, and the `mappingHash` an apply must carry.
   * Read-only (creates nothing). Reveals env-adjacent plan data like `plan`, so it needs `read:secrets`.
   */
  @Post("mapping/resolve")
  @RequireScopes("read:secrets")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiZodBody(ImportMappingResolveSchema)
  resolveMapping(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ImportMappingResolveSchema)) body: ImportMappingResolveInput,
  ) {
    return this.importer.resolveMapping(user.userId, body);
  }

  /** End an import session now (the wizard's "Start over"): its stored token can no longer be used. */
  /**
   * The owner's own answer to "is this Coolify server the same machine as that Tugra server" for an agent session (or "not the same", or
   * a reset). Refused when the machine identity of the two differs. `write` scope; owner/admin of the session's team.
   */
  @Put("sessions/:sessionId/host-link")
  @RequireScopes("write")
  @ApiZodBody(ImportHostLinkSchema)
  setHostLink(
    @CurrentUser() user: AuthUser,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(ImportHostLinkSchema)) body: ImportHostLinkInput,
  ) {
    return this.importer.setHostLink(user.userId, sessionId, body);
  }

  @Delete("sessions/:sessionId")
  @RequireScopes("deploy")
  revokeSession(@CurrentUser() user: AuthUser, @Param("sessionId") sessionId: string) {
    return this.importer.revokeSession(user.userId, sessionId);
  }

  /** The saved mapping profile for this session's source scope (`doc` is null when none is saved). */
  @Get("sessions/:sessionId/mapping")
  @RequireScopes("read:secrets")
  getMapping(@CurrentUser() user: AuthUser, @Param("sessionId") sessionId: string) {
    return this.importer.getMapping(user.userId, sessionId);
  }

  /** Save the mapping profile (shape-validated only, so a file can be saved offline). A stale `expectedVersion`
   *  is refused with 409 `import.mapping_version_conflict`. */
  @Put("sessions/:sessionId/mapping")
  @RequireScopes("deploy")
  @ApiZodBody(ImportMappingPutSchema)
  putMapping(
    @CurrentUser() user: AuthUser,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(ImportMappingPutSchema)) body: ImportMappingPutInput,
  ) {
    return this.importer.putMapping(user.userId, sessionId, body);
  }

  /** Delete the saved mapping profile for this session's source scope. */
  @Delete("sessions/:sessionId/mapping")
  @RequireScopes("deploy")
  deleteMapping(@CurrentUser() user: AuthUser, @Param("sessionId") sessionId: string) {
    return this.importer.deleteMapping(user.userId, sessionId);
  }

  /** Poll an import operation's progress (read-only). */
  @Get("operations/:opId")
  status(@CurrentUser() user: AuthUser, @Param("opId") opId: string) {
    return this.executor.status(user.userId, opId);
  }

  /** Request cancellation of an in-flight import (stops launching new adoptions; running ones finish). */
  @Post("operations/:opId/cancel")
  @RequireScopes("deploy")
  cancel(@CurrentUser() user: AuthUser, @Param("opId") opId: string) {
    return this.executor.cancel(user.userId, opId);
  }

  /** Undo an import's completed adoptions (renames each container back + drops its app record). Admin-tier:
   *  destructive. */
  @Post("operations/:opId/rollback")
  @RequireScopes("admin")
  rollback(@CurrentUser() user: AuthUser, @Param("opId") opId: string) {
    return this.executor.rollback(user.userId, opId);
  }

  /** Mint a one-time migration token + the one-line command the untrusted SOURCE host runs to stream its
   *  volume/DB data to this hub. Deploy-tier (authorizes writes into the dest) AND read:secrets (the
   *  response carries a credential). Shown ONCE — the token is hashed at rest. */
  @Post("operations/:opId/migration-token")
  @RequireScopes("deploy", "read:secrets")
  mintMigrationToken(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Req() req: ReqLike, @Query("certs") certs?: string) {
    return this.executor.mintMigrationToken(user.userId, opId, hubBaseUrl(publicUrlFrom(req)), { certs: certs === "1" });
  }

  /** Rotate the migration token (revoke the old + mint a new one). Same scope as mint. */
  @Post("operations/:opId/migration-token/reissue")
  @RequireScopes("deploy", "read:secrets")
  reissueMigrationToken(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Req() req: ReqLike, @Query("certs") certs?: string) {
    return this.executor.reissueMigrationToken(user.userId, opId, hubBaseUrl(publicUrlFrom(req)), { certs: certs === "1" });
  }

  /** Read-only migration state + a command TEMPLATE (never the live token). Read scope: it cannot return a
   *  credential (the token is unrecoverable after mint). */
  @Get("operations/:opId/migrate-command")
  migrateCommand(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Req() req: ReqLike, @Query("certs") certs?: string) {
    return this.executor.migrateCommand(user.userId, opId, hubBaseUrl(publicUrlFrom(req)), { certs: certs === "1" });
  }

  /** READ-ONLY preview of the env rewrites that would point each migrated app at its new Tugra database.
   *  Writes nothing; returns a secret-MASKED diff + a planHash to confirm the (separate) apply against. It
   *  decrypts env + DB credentials server-side, so it needs `read:secrets` (like plan); the service also
   *  re-checks apps:config + databases on the target team. */
  @Get("operations/:opId/remap-env/plan")
  @RequireScopes("read:secrets")
  remapEnvPlan(@CurrentUser() user: AuthUser, @Param("opId") opId: string) {
    return this.executor.remapEnvPlan(user.userId, opId);
  }

  /** Apply the previewed env-remap: the first WRITE of the remap flow, confirm-gated. `confirmToken` must
   *  equal the preview's planHash or the apply is refused (409) — a stale diff is never written. It reads
   *  env + DB credentials (read:secrets) and takes over the migrated workloads' wiring (deploy). The prior
   *  env is snapshotted for a one-call undo; the response is secret-free (counts + keys only). */
  @Post("operations/:opId/remap-env")
  @RequireScopes("deploy", "read:secrets")
  @ApiZodBody(ImportRemapEnvSchema)
  remapEnvApply(
    @CurrentUser() user: AuthUser,
    @Param("opId") opId: string,
    @Body(new ZodValidationPipe(ImportRemapEnvSchema)) body: ImportRemapEnvInput,
  ) {
    return this.executor.remapEnvApply(user.userId, opId, body.confirmToken);
  }

  /** Reverse the env-remap: restore each app's env to the snapshot taken before it was applied. Deploy-tier
   *  (it rewrites app config). Refuses (409) if no remap has been applied. */
  @Post("operations/:opId/remap-env/undo")
  @RequireScopes("deploy")
  remapEnvUndo(@CurrentUser() user: AuthUser, @Param("opId") opId: string) {
    return this.executor.remapEnvUndo(user.userId, opId);
  }

  /** Per-volume state of the streamed data copy: progress, the migrator's inventory (labelled as reported by it), the
   *  disk verdict and, for a Postgres data volume, every gate with its evidence. Read-only; secret-free. */
  @Get("operations/:opId/volumes")
  volumes(@CurrentUser() user: AuthUser, @Param("opId") opId: string) {
    return this.vx.listVolumes(user.userId, opId);
  }

  /** Dry-run size check of the target host for one volume (against the inventory bytes unless `rawBytes` is given).
   *  Probes the target read-only; no data moves. */
  @Post("operations/:opId/volumes/:itemRef/disk-check")
  @RequireScopes("deploy")
  @ApiZodBody(VxDiskCheckBodySchema)
  volumeDiskCheck(
    @CurrentUser() user: AuthUser,
    @Param("opId") opId: string,
    @Param("itemRef") itemRef: string,
    @Body(new ZodValidationPipe(VxDiskCheckBodySchema)) body: VxDiskCheckBody,
  ) {
    return this.vx.diskCheck(opId, user.userId, itemRef, body.rawBytes);
  }

  /** Explicitly mark a volume NOT migrated (needs the acknowledgement). The migrator reports it `volume-not-migrated`. */
  @Post("operations/:opId/volumes/:itemRef/exclude")
  @RequireScopes("deploy")
  @ApiZodBody(VxExcludeBodySchema)
  volumeExclude(
    @CurrentUser() user: AuthUser,
    @Param("opId") opId: string,
    @Param("itemRef") itemRef: string,
    @Body(new ZodValidationPipe(VxExcludeBodySchema)) body: VxExcludeBody,
  ) {
    return this.vx.setExcluded(user.userId, opId, itemRef, true, body.reason);
  }

  /** Undo an exclusion (the volume is migrated again). */
  @Post("operations/:opId/volumes/:itemRef/include")
  @RequireScopes("deploy")
  volumeInclude(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Param("itemRef") itemRef: string) {
    return this.vx.setExcluded(user.userId, opId, itemRef, false);
  }

  /** Stop the streamed copy of one volume from the UI. A live migrator's next call gets `vx-aborted` and exits. */
  @Post("operations/:opId/volumes/:itemRef/abort")
  @RequireScopes("deploy")
  volumeAbort(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Param("itemRef") itemRef: string) {
    return this.vx.userAbort(user.userId, opId, itemRef);
  }

  /** Start one volume over: discards its staged parts and the partial destination (a live copy is only aborted first). */
  @Post("operations/:opId/volumes/:itemRef/reset")
  @RequireScopes("deploy")
  volumeReset(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Param("itemRef") itemRef: string) {
    return this.vx.userReset(user.userId, opId, itemRef);
  }
}

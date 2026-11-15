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
import {
  ImportConnectSchema,
  type ImportConnectInput,
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

@ApiTags("import")
@ApiSecurity("pat")
@Controller("import")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ImporterController {
  constructor(
    private readonly importer: ImporterService,
    private readonly executor: ImportExecutorService,
    private readonly gitLinks: ImportGitLinksService,
  ) {}

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
}

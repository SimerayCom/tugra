import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiRefResponse, ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { hubBaseUrl, publicUrlFrom, type ReqLike } from "../common/hub-url";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import {
  AbortRunSchema, type AbortRunInput,
  AttachSchema, type AttachInput,
  CleanupRunSchema, type CleanupRunInput,
  CreateMigrationRunSchema, type CreateMigrationRunInput,
  DecommissionRunSchema, type DecommissionRunInput,
  ListMigrationRunsQuerySchema, type ListMigrationRunsQuery,
  MigrationRunSummarySchema,
  ReverseRunSchema, type ReverseRunInput,
  RunCommandResultSchema,
  RunCommandSchema, type RunCommandInput,
  RunEventsPageSchema,
  RunEventsQuerySchema, type RunEventsQuery,
  RunReportQuerySchema, type RunReportQuery,
  RunReportSchema,
  SetRunInputsSchema, type SetRunInputsInput,
  SourceAgentsQuerySchema, type SourceAgentsQuery,
  SourceAgentsResultSchema,
  SourceSessionResultSchema,
  SourceSessionSchema, type SourceSessionInput,
  StartRunSchema, type StartRunInput,
  StepApproveSchema, type StepApproveInput,
  StepEvidenceInputSchema, type StepEvidenceInput,
  StepKeySchema,
  StepRetrySchema, type StepRetryInput,
  StepSkipSchema, type StepSkipInput,
} from "./core/dto";
import { MIGRATION_RUNS_FACADE, runActorFromAuth, type MigrationRunsFacade, type StepKey } from "./core/run-contract";

/** The slice of the HTTP response the markdown report needs (avoids a hard @types/express dependency). */
interface ResLike {
  setHeader(name: string, value: string): unknown;
}

const stepKeyPipe = new ZodValidationPipe(StepKeySchema);

/**
 * One-click Coolify/Dokploy -> Tugra migration orchestrator. Every route delegates to the {@link MigrationRunsFacade};
 * the facade re-checks creator-only ownership and team permissions, this controller only authenticates, checks the
 * token scope per route (`deploy` to drive, `read:secrets` where a credential is minted or a source token handled,
 * `admin` for cleanup/reverse/decommission) and validates the request with the zod schemas of `core/dto.ts`.
 */
@ApiTags("import")
@ApiSecurity("pat")
@Controller("migration-runs")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class MigrationRunsController {
  constructor(@Inject(MIGRATION_RUNS_FACADE) private readonly runs: MigrationRunsFacade) {}

  /** Create a run (201). With `dryRun: true` it only projects and ends DRY_RUN_DONE; it writes nothing outside its own rows. */
  @Post()
  @RequireScopes("deploy", "read:secrets")
  @ApiZodBody(CreateMigrationRunSchema)
  @ApiRefResponse("MigrationRunView", { status: 201 })
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateMigrationRunSchema)) body: CreateMigrationRunInput) {
    return this.runs.create(runActorFromAuth(user), body);
  }

  /** The caller's runs on the teams they belong to, newest first. */
  @Get()
  @ApiZodResponse(MigrationRunSummarySchema, { isArray: true })
  list(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(ListMigrationRunsQuerySchema)) query: ListMigrationRunsQuery) {
    return this.runs.list(runActorFromAuth(user), query);
  }

  /** Secret-free view: steps, gates, progress, nextAction, window estimate/measured, PONR. */
  @Get(":id")
  @ApiRefResponse("MigrationRunView")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.runs.get(runActorFromAuth(user), id);
  }

  /** Polling cursor over the append-only event log. */
  @Get(":id/events")
  @ApiZodResponse(RunEventsPageSchema)
  events(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query(new ZodValidationPipe(RunEventsQuerySchema)) query: RunEventsQuery) {
    return this.runs.events(runActorFromAuth(user), id, query);
  }

  /** Start the run; on a DRY_RUN_DONE run it promotes into a NEW real run and returns that one. */
  @Post(":id/start")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiZodBody(StartRunSchema)
  @ApiRefResponse("MigrationRunView")
  start(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(StartRunSchema)) body: StartRunInput) {
    return this.runs.start(runActorFromAuth(user), id, body);
  }

  /** Approve a waiting step with a hash-bound, typed approval (the PONR approval is refused over MCP). */
  @Post(":id/steps/:key/approve")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiZodBody(StepApproveSchema)
  @ApiRefResponse("MigrationRunView")
  approve(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("key", stepKeyPipe) key: StepKey, @Body(new ZodValidationPipe(StepApproveSchema)) body: StepApproveInput) {
    return this.runs.approve(runActorFromAuth(user), id, key, body);
  }

  /** Re-enter a failed or waiting step (IMPORT retry = rollback + re-apply on a fresh op). */
  @Post(":id/steps/:key/retry")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiZodBody(StepRetrySchema)
  @ApiRefResponse("MigrationRunView")
  retry(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("key", stepKeyPipe) key: StepKey, @Body(new ZodValidationPipe(StepRetrySchema)) body: StepRetryInput) {
    return this.runs.retry(runActorFromAuth(user), id, key, body);
  }

  /** Skip a skippable step (DATA_SEED). */
  @Post(":id/steps/:key/skip")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiZodBody(StepSkipSchema)
  @ApiRefResponse("MigrationRunView")
  skip(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("key", stepKeyPipe) key: StepKey, @Body(new ZodValidationPipe(StepSkipSchema)) body: StepSkipInput) {
    return this.runs.skip(runActorFromAuth(user), id, key, body);
  }

  /** Record an operator attestation for a check the step lists as attestable. */
  @Post(":id/steps/:key/evidence")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiZodBody(StepEvidenceInputSchema)
  @ApiRefResponse("MigrationRunView")
  evidence(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("key", stepKeyPipe) key: StepKey, @Body(new ZodValidationPipe(StepEvidenceInputSchema)) body: StepEvidenceInput) {
    return this.runs.evidence(runActorFromAuth(user), id, key, body);
  }

  /** Attach an existing resource (an object migration id) to the step. Object-store credentials never pass through this API. */
  @Post(":id/steps/:key/attach")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiZodBody(AttachSchema)
  @ApiRefResponse("MigrationRunView")
  attach(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("key", stepKeyPipe) key: StepKey, @Body(new ZodValidationPipe(AttachSchema)) body: AttachInput) {
    return this.runs.attach(runActorFromAuth(user), id, key, body);
  }

  /** Mint/reissue the migrator token and return the exact source-host command. Shown ONCE (the response carries a credential). */
  @Post(":id/steps/:key/command")
  @HttpCode(200)
  @RequireScopes("deploy", "read:secrets")
  @ApiZodBody(RunCommandSchema)
  @ApiZodResponse(RunCommandResultSchema)
  command(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("key", stepKeyPipe) key: StepKey,
    @Req() req: ReqLike,
    @Body(new ZodValidationPipe(RunCommandSchema)) body: RunCommandInput,
  ) {
    return this.runs.command(runActorFromAuth(user), id, key, body, hubBaseUrl(publicUrlFrom(req)));
  }

  /** Set or change owner inputs (ACME email, bind-mount consent, live-probe consent, source controller). */
  @Post(":id/inputs")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiZodBody(SetRunInputsSchema)
  @ApiRefResponse("MigrationRunView")
  setInputs(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(SetRunInputsSchema)) body: SetRunInputsInput) {
    return this.runs.setInputs(runActorFromAuth(user), id, body);
  }

  /** Stop forward progress. Nothing is undone. */
  @Post(":id/pause")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiRefResponse("MigrationRunView")
  pause(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.runs.pause(runActorFromAuth(user), id);
  }

  @Post(":id/resume")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiRefResponse("MigrationRunView")
  resume(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.runs.resume(runActorFromAuth(user), id);
  }

  /** Abort before the point of no return: Coolify becomes authoritative again; nothing is deleted (409 after PONR). */
  @Post(":id/abort")
  @HttpCode(202)
  @RequireScopes("deploy")
  @ApiZodBody(AbortRunSchema)
  @ApiRefResponse("MigrationRunView", { status: 202 })
  abort(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(AbortRunSchema)) body: AbortRunInput) {
    return this.runs.abort(runActorFromAuth(user), id, body);
  }

  /** After an abort: remove the Tugra-side created resources (data-bearing ones need includeData + typed names). */
  @Post(":id/cleanup")
  @HttpCode(202)
  @RequireScopes("admin")
  @ApiZodBody(CleanupRunSchema)
  @ApiRefResponse("MigrationRunView", { status: 202 })
  cleanup(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(CleanupRunSchema)) body: CleanupRunInput) {
    return this.runs.cleanup(runActorFromAuth(user), id, body);
  }

  /** After the point of no return: the lossy reverse (DNS ledger restore / proxy swap reverse). Needs the data-loss acknowledgement. */
  @Post(":id/reverse")
  @HttpCode(202)
  @RequireScopes("admin")
  @ApiZodBody(ReverseRunSchema)
  @ApiRefResponse("MigrationRunView", { status: 202 })
  reverse(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(ReverseRunSchema)) body: ReverseRunInput) {
    return this.runs.reverse(runActorFromAuth(user), id, body);
  }

  /** Takeover only, after FINALIZE: stop (never delete) the source containers and print the removal commands. */
  @Post(":id/decommission")
  @HttpCode(202)
  @RequireScopes("admin")
  @ApiZodBody(DecommissionRunSchema)
  @ApiRefResponse("MigrationRunView", { status: 202 })
  decommission(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(DecommissionRunSchema)) body: DecommissionRunInput) {
    return this.runs.decommission(runActorFromAuth(user), id, body);
  }

  /** Re-enter the source token when the 1 h import session expired. The token is never returned. */
  @Post(":id/source-session")
  @HttpCode(200)
  @RequireScopes("deploy", "read:secrets")
  @ApiZodBody(SourceSessionSchema)
  @ApiZodResponse(SourceSessionResultSchema)
  sourceSession(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(SourceSessionSchema)) body: SourceSessionInput) {
    return this.runs.sourceSession(runActorFromAuth(user), id, body);
  }

  /** On a finished dry run: the source servers without an online agent, which a promotion refuses on. Read-only; names and states only. */
  @Get(":id/source-agents")
  @ApiZodResponse(SourceAgentsResultSchema)
  sourceAgents(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query(new ZodValidationPipe(SourceAgentsQuerySchema)) query: SourceAgentsQuery) {
    return this.runs.sourceAgents(runActorFromAuth(user), id, query);
  }

  /** The final, secret-free report: JSON (default) or Markdown (`?format=md`, served as text/markdown). */
  @Get(":id/report")
  @ApiZodResponse(RunReportSchema)
  async report(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(RunReportQuerySchema)) query: RunReportQuery,
    @Res({ passthrough: true }) res: ResLike,
  ) {
    const actor = runActorFromAuth(user);
    if (query.format === "md") {
      const md = await this.runs.reportMarkdown(actor, id);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      return md;
    }
    return this.runs.report(actor, id);
  }
}

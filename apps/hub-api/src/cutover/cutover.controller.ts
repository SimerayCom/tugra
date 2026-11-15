import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CutoverService } from "./cutover.service";
import { CutoverCertService } from "./cutover-cert.service";
import { CUTOVER_HOSTNAME_RE } from "./cutover.logic";
import {
  CutoverCertPrepSchema, type CutoverCertPrepInput,
  CutoverCheckSchema, type CutoverCheckInput,
  CutoverExcludeSchema, type CutoverExcludeInput,
  CutoverFinalizeSchema, type CutoverFinalizeInput,
  CutoverFixCounterpartSchema, type CutoverFixCounterpartInput,
  CutoverFlipPlanQuerySchema, type CutoverFlipPlanQuery,
  CutoverFlipSchema, type CutoverFlipInput,
  CutoverInitSchema, type CutoverInitInput,
  CutoverRevertSchema, type CutoverRevertInput,
  CutoverSeedCertsSchema, type CutoverSeedCertsInput,
  CutoverTtlSchema, type CutoverTtlInput,
} from "./cutover.dto";

/**
 * SSL/DNS cutover of an imported op's hostnames. Every route resolves the op through the importer's ownership loader
 * and re-checks `apps:config` per touched app; a request only matches hostnames that already exist as entries of the
 * op, so it can never write an arbitrary DNS record. Scopes follow the remap precedent.
 */
@ApiTags("import")
@ApiSecurity("pat")
@Controller("import/operations/:opId/cutover")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class CutoverController {
  constructor(
    private readonly cutover: CutoverService,
    private readonly certs: CutoverCertService,
  ) {}

  /** Derive/refresh the tracked hostnames from the op's DONE apps (idempotent). Reads DNS, writes nothing to any provider. */
  @Post("init")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(CutoverInitSchema)
  init(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Body(new ZodValidationPipe(CutoverInitSchema)) body: CutoverInitInput) {
    return this.cutover.init(user.userId, opId, body);
  }

  /** The cutover state: per-host entries, per-server preflight, the current run. Also settles a crashed run. */
  @Get()
  view(@CurrentUser() user: AuthUser, @Param("opId") opId: string) {
    return this.cutover.view(user.userId, opId);
  }

  /** Choose DNS-01 (per host) or HTTP-01 per app. Does not deploy; entries report `needsDeploy`. */
  @Post("cert-prepare")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(CutoverCertPrepSchema)
  certPrepare(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Body(new ZodValidationPipe(CutoverCertPrepSchema)) body: CutoverCertPrepInput) {
    return this.cutover.certPrepare(user.userId, opId, body);
  }

  /** Probe each host through the Tugra proxy (Host header + SNI at the server IP) and advance the state machine. */
  @Post("check")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(CutoverCheckSchema)
  check(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Body(new ZodValidationPipe(CutoverCheckSchema)) body: CutoverCheckInput) {
    return this.cutover.check(user.userId, opId, body);
  }

  /** Lower the TTL on unproxied Cloudflare records (manual-DNS hosts get guidance only). */
  @Post("ttl")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(CutoverTtlSchema)
  ttl(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Body(new ZodValidationPipe(CutoverTtlSchema)) body: CutoverTtlInput) {
    return this.cutover.ttl(user.userId, opId, body);
  }

  /** Read-only exact record diff + the confirm token. Decrypts the Cloudflare token server-side, so `read:secrets`. */
  @Get("flip-plan")
  @RequireScopes("read:secrets")
  flipPlan(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Query(new ZodValidationPipe(CutoverFlipPlanQuerySchema)) q: CutoverFlipPlanQuery) {
    for (const h of q.hostnames ? q.hostnames.split(",") : []) if (!CUTOVER_HOSTNAME_RE.test(h.trim().toLowerCase())) throw new BadRequestException("invalid hostname in hostnames");
    return this.cutover.flipPlan(user.userId, opId, q);
  }

  /** Start the confirm-gated, batched flip (202; poll GET /). `confirmToken` must equal a fresh plan's hash. */
  @Post("flip")
  @RequireScopes("deploy")
  @HttpCode(202)
  @ApiZodBody(CutoverFlipSchema)
  flip(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Body(new ZodValidationPipe(CutoverFlipSchema)) body: CutoverFlipInput) {
    return this.cutover.flip(user.userId, opId, body);
  }

  /** Stop the run after the current batch. */
  @Post("cancel")
  @RequireScopes("deploy")
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param("opId") opId: string) {
    return this.cutover.cancel(user.userId, opId);
  }

  /** Restore DNS records from the ledger. Cannot restore data Tugra wrote after the flip. */
  @Post("revert")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(CutoverRevertSchema)
  revert(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Body(new ZodValidationPipe(CutoverRevertSchema)) body: CutoverRevertInput) {
    return this.cutover.revert(user.userId, opId, body);
  }

  /** Restore the original TTL on VERIFIED hosts and stamp them finalized. */
  @Post("finalize")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(CutoverFinalizeSchema)
  finalize(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Body(new ZodValidationPipe(CutoverFinalizeSchema)) body: CutoverFinalizeInput) {
    return this.cutover.finalize(user.userId, opId, body);
  }

  /** Set the app's www/bare redirect so the counterpart host is served (needs a redeploy). */
  @Post("fix-counterpart")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(CutoverFixCounterpartSchema)
  fixCounterpart(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Body(new ZodValidationPipe(CutoverFixCounterpartSchema)) body: CutoverFixCounterpartInput) {
    return this.cutover.fixCounterpart(user.userId, opId, body);
  }

  /** Exclude/include hosts (Coolify-generated hostnames are excluded by default). */
  @Post("exclude")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(CutoverExcludeSchema)
  exclude(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Body(new ZodValidationPipe(CutoverExcludeSchema)) body: CutoverExcludeInput) {
    return this.cutover.exclude(user.userId, opId, body);
  }

  /** Merge the staged source certificates (migrator `--certs`) into the target proxy's own acme.json. Restarts the proxy. */
  @Post("seed-certs")
  @RequireScopes("deploy", "read:secrets")
  @HttpCode(200)
  @ApiZodBody(CutoverSeedCertsSchema)
  async seedCerts(@CurrentUser() user: AuthUser, @Param("opId") opId: string, @Body(new ZodValidationPipe(CutoverSeedCertsSchema)) body: CutoverSeedCertsInput) {
    const r = await this.certs.seed(user.userId, opId, body);
    return { applied: r.applied, view: await this.cutover.view(user.userId, opId) };
  }
}

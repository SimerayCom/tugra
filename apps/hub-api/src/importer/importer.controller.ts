import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
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
} from "./dto";

@ApiTags("import")
@ApiSecurity("pat")
@Controller("import")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ImporterController {
  constructor(
    private readonly importer: ImporterService,
    private readonly executor: ImportExecutorService,
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
}

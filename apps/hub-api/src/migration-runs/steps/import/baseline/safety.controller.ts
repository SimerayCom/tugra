import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Put, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../../../../openapi/openapi";
import { ZodValidationPipe } from "../../../../common/zod-validation.pipe";
import { CurrentUser } from "../../../../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../../../../api-tokens/api-auth.guard";
import { ScopesGuard } from "../../../../api-tokens/scopes.guard";
import { RequireScopes } from "../../../../api-tokens/require-scopes.decorator";
import { AuthUser } from "../../../../auth/strategies/jwt.strategy";
import { PrismaService } from "../../../../prisma/prisma.service";
import { TeamAccessService } from "../../../../common/team-access.service";
import { SafetyHintsSchema, SetImagePinsSchema, SetWorkerMarksSchema, type SafetyHints, type SetImagePinsInput, type SetWorkerMarksInput } from "./hints.dto";
import { RUN_HINTS, type RunHint, type RunHintStore } from "./run-hints";

/** A run in one of these has nothing left to decide: the hints would change nothing. */
const CLOSED = new Set(["COMPLETED", "ABORTED", "ROLLING_BACK", "ROLLED_BACK", "REVERSING", "REVERSED"]);

/**
 * The facts a guided migration needs from the people who can see the SOURCE HOST (this hub only reads the source's API):
 * the digest the source runs for an unpinned image, and which apps are job runners. Both are secret-free, attested by the
 * caller (the hub verifies neither) and read by the import-side steps. Access is the run's own rule: only the creator reaches a
 * run (404 for anyone else, like every `migration-runs` route), who must still be a member of its team; writing needs the
 * same team permissions that driving the run needs.
 */
@ApiTags("import")
@ApiSecurity("pat")
@Controller("migration-runs")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class RunSafetyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    @Inject(RUN_HINTS) private readonly hints: RunHintStore,
  ) {}

  /** The digests and job-runner marks recorded for the run (and, for a promoted run, the dry-run it came from). */
  @Get(":id/safety-hints")
  @ApiZodResponse(SafetyHintsSchema)
  async get(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<SafetyHints> {
    const v = await this.load(user, id, false);
    return view(await this.hints.list(v.id, v.promotedFromId));
  }

  /** Record (or, with `digest: null`, remove) the digest the source runs for a floating image. */
  @Put(":id/image-pins")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiZodBody(SetImagePinsSchema)
  @ApiZodResponse(SafetyHintsSchema)
  async setPins(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(SetImagePinsSchema)) body: SetImagePinsInput): Promise<SafetyHints> {
    const v = await this.open(user, id);
    const set: RunHint[] = body.pins.filter((p) => p.digest !== null).map((p) => ({ kind: "image-pin", key: p.image, scope: p.scope, value: p.digest as string, evidence: p.evidence }));
    await this.hints.upsert(v.id, set);
    await this.hints.remove(v.id, body.pins.filter((p) => p.digest === null).map((p) => ({ kind: "image-pin" as const, key: p.image, scope: p.scope })));
    return view(await this.hints.list(v.id, v.promotedFromId));
  }

  /** Mark an app a job runner (held until after the cutover) or a web app (starts dark even without a domain); `role: null` removes the mark. */
  @Put(":id/worker-marks")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiZodBody(SetWorkerMarksSchema)
  @ApiZodResponse(SafetyHintsSchema)
  async setMarks(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(SetWorkerMarksSchema)) body: SetWorkerMarksInput): Promise<SafetyHints> {
    const v = await this.open(user, id);
    const set: RunHint[] = body.marks.filter((m) => m.role !== null).map((m) => ({ kind: "worker-mark", key: m.itemRef, scope: "", value: m.role as string, evidence: "operator-attested" }));
    await this.hints.upsert(v.id, set);
    await this.hints.remove(v.id, body.marks.filter((m) => m.role === null).map((m) => ({ kind: "worker-mark" as const, key: m.itemRef, scope: "" })));
    return view(await this.hints.list(v.id, v.promotedFromId));
  }

  private async load(user: AuthUser, id: string, acting: boolean) {
    const v = await this.prisma.migrationRun.findUnique({ where: { id }, select: { id: true, teamId: true, actorId: true, status: true, ponrAt: true, promotedFromId: true } });
    if (!v || v.actorId !== user.userId) throw new NotFoundException("run-not-found");
    const perms = await this.access.membershipPermissions(user.userId, v.teamId);
    if (!perms) throw new NotFoundException("run-not-found");
    if (acting && !(perms.has("apps:config") && perms.has("databases"))) throw new ForbiddenException("insufficient-permission");
    return v;
  }

  private async open(user: AuthUser, id: string) {
    const v = await this.load(user, id, true);
    if (CLOSED.has(v.status) || v.ponrAt) throw new ConflictException("hints-closed");
    return v;
  }
}

function view(hints: readonly RunHint[]): SafetyHints {
  return {
    imagePins: hints.filter((h) => h.kind === "image-pin").map((h) => ({ image: h.key, scope: h.scope, digest: h.value, evidence: h.evidence })),
    workerMarks: hints.filter((h) => h.kind === "worker-mark" && (h.value === "job-runner" || h.value === "web")).map((h) => ({ itemRef: h.key, role: h.value as "job-runner" | "web" })),
  };
}

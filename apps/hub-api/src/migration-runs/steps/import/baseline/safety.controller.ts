import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Put, UseGuards } from "@nestjs/common";
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
import { SafetyHintsSchema, SetExactImagesSchema, SetImagePinsSchema, SetServicePinsSchema, SetWarningAcksSchema, SetWorkerMarksSchema, type SafetyHints, type SetExactImagesInput, type SetImagePinsInput, type SetServicePinsInput, type SetWarningAcksInput, type SetWorkerMarksInput } from "./hints.dto";
import { fixedKeys, warningKeysOf, warningsOf } from "../../../core/dry-run-warnings";
import { imageRepoOf, isFloatingImage, servicePinKey } from "./image-pins";
import { EXACT_OFF_KIND, exactRows, isExactOff } from "./exact-images";
import { exactCandidatesOf, exactKeyOf, type ExactMeta } from "../../data/inventory/inventory-pins";
import { isDigestPinned } from "../../../../importer/exact-image";
import { RUN_HINTS, type RunHint, type RunHintStore } from "./run-hints";

/** The most warning keys one run keeps accepted. */
const MAX_WARNING_ACKS = 200;
/** The most compose-stack members one dry run keeps pinned (a stack choice map holds at most 64 stacks). */
const MAX_SERVICE_PINS = 200;
/** The most items one run keeps unticked from "keep the exact image". */
const MAX_EXACT_OFF = 500;

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
    return this.viewOf(v, await this.hints.list(v.id, v.promotedFromId));
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
    return this.viewOf(v, await this.hints.list(v.id, v.promotedFromId));
  }

  /** Mark an app a job runner (an app with no domain: held until after the cutover; PREFLIGHT refuses the mark on an app that serves one) or a web app (starts dark even without a domain); `role: null` removes the mark. An itemRef that matches no app of the plan is refused by PREFLIGHT and DEPLOY_DARK. */
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
    return this.viewOf(v, await this.hints.list(v.id, v.promotedFromId));
  }

  /**
   * Accept (`accepted: true`) or take back the acceptance of the warnings a finished dry-run showed. Only a dry-run that is
   * done takes them (409 otherwise): a real run has no decision screen. The promoted run reads them from its parent.
   */
  @Put(":id/warning-acks")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiZodBody(SetWarningAcksSchema)
  @ApiZodResponse(SafetyHintsSchema)
  async setWarningAcks(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(SetWarningAcksSchema)) body: SetWarningAcksInput): Promise<SafetyHints> {
    const v = await this.load(user, id, true);
    if (v.status !== "DRY_RUN_DONE") throw new ConflictException("not-a-finished-dry-run");
    // only a warning this very dry run showed can be accepted: a key it never raised would sit in the table as a claim about nothing
    const shown = warningKeysOf(await this.stepsOf(v.id));
    if (body.acks.some((a) => a.accepted && !shown.has(a.key))) throw new BadRequestException("unknown-warning");
    const ref = (k: string) => ({ kind: "warning-ack" as const, key: k, scope: "" });
    // a dry run shows a few dozen distinct warnings at most: the total is capped so repeated calls cannot grow the table
    const next = new Set((await this.hints.list(v.id)).filter((h) => h.kind === "warning-ack").map((h) => h.key));
    for (const a of body.acks) a.accepted ? next.add(a.key) : next.delete(a.key);
    if (next.size > MAX_WARNING_ACKS) throw new BadRequestException("too-many-warning-acks");
    await this.hints.upsert(v.id, body.acks.filter((a) => a.accepted).map((a) => ({ ...ref(a.key), value: "accepted", evidence: "operator-attested" as const })));
    await this.hints.remove(v.id, body.acks.filter((a) => !a.accepted).map((a) => ref(a.key)));
    return this.viewOf(v, await this.hints.list(v.id, v.promotedFromId));
  }

  /**
   * Pin (or unpin) floating members of compose stacks on a finished dry run, in one call: the "pin to the source version" action of the
   * result screen. Only a member the dry run itself listed can be pinned, and only to a version of the repository the source writes for
   * it (never another image), so a pin cannot swap what a stack runs. The promoted run writes the pins into the stack's choices.
   */
  @Put(":id/service-pins")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiZodBody(SetServicePinsSchema)
  @ApiZodResponse(SafetyHintsSchema)
  async setServicePins(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(SetServicePinsSchema)) body: SetServicePinsInput): Promise<SafetyHints> {
    const v = await this.load(user, id, true);
    if (v.status !== "DRY_RUN_DONE") throw new ConflictException("not-a-finished-dry-run");
    const listed = listedMembers(await this.stepsOf(v.id));
    const set: RunHint[] = [];
    const drop: Array<Pick<RunHint, "kind" | "key" | "scope">> = [];
    for (const p of body.pins) {
      const key = servicePinKey(p.itemRef, p.member);
      const row = listed.get(key);
      if (!row) throw new BadRequestException("unknown-image");
      if (p.ref === null) {
        drop.push({ kind: "service-pin", key, scope: "" });
        continue;
      }
      if (isFloatingImage(p.ref) || imageRepoOf(p.ref) !== imageRepoOf(row.image)) throw new BadRequestException("invalid-pin");
      set.push({ kind: "service-pin", key, scope: "", value: p.ref, evidence: row.seen === p.ref ? "source-api-reported" : "operator-attested" });
    }
    const hints = await this.hints.list(v.id);
    const total = new Set([...hints.filter((h) => h.kind === "service-pin").map((h) => h.key), ...set.map((h) => h.key)]);
    for (const d of drop) total.delete(d.key);
    if (total.size > MAX_SERVICE_PINS) throw new BadRequestException("too-many-service-pins");
    await this.hints.upsert(v.id, set);
    await this.hints.remove(v.id, drop);
    return this.viewOf(v, await this.hints.list(v.id, v.promotedFromId));
  }

  /**
   * Tick or untick "keep the exact image" per item. The default is ticked: a run pins every app, database and stack member to the image
   * the source host reports. Unticking records an `exact-off` hint (the recorded image stays, so ticking again needs no new inventory);
   * the apply, the database start and DEPLOY_DARK all skip an item with that hint. Ticking again records `on`.
   */
  @Put(":id/exact-images")
  @HttpCode(200)
  @RequireScopes("deploy")
  @ApiZodBody(SetExactImagesSchema)
  @ApiZodResponse(SafetyHintsSchema)
  async setExactImages(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(SetExactImagesSchema)) body: SetExactImagesInput): Promise<SafetyHints> {
    const v = await this.open(user, id);
    const total = new Set((await this.hints.list(v.id, v.promotedFromId)).filter((h) => h.kind === EXACT_OFF_KIND && h.value === "off").map((h) => h.key));
    for (const i of body.items) i.keep ? total.delete(i.itemRef) : total.add(i.itemRef);
    if (total.size > MAX_EXACT_OFF) throw new BadRequestException("too-many-exact-images");
    // `on` (not a removal) so that ticking the box again also overrides an `off` of the dry run this run was promoted from (the run's own hint wins)
    await this.hints.upsert(v.id, body.items.map((i) => ({ kind: EXACT_OFF_KIND, key: i.itemRef, scope: "", value: i.keep ? "on" : "off", evidence: "operator-attested" as const })));
    return this.viewOf(v, await this.hints.list(v.id, v.promotedFromId));
  }

  private async stepsOf(runId: string): Promise<Array<{ progress: unknown }>> {
    return this.prisma.migrationRunStep.findMany({ where: { runId }, select: { progress: true } });
  }

  private async viewOf(v: { id: string; status: string; opId?: string | null; promotedFromId?: string | null }, hints: readonly RunHint[]): Promise<SafetyHints> {
    const fixed = v.status === "DRY_RUN_DONE" ? fixedKeys(await this.stepsOf(v.id), hints) : [];
    return view(hints, fixed, await this.unknownExact(v, hints));
  }

  /** The items of the op's plan an inventory covered and still has no exact image for (see `SafetyHintsSchema.exactUnknown`). Best effort: an unreadable plan lists none. */
  private async unknownExact(v: { id: string; opId?: string | null; promotedFromId?: string | null }, hints: readonly RunHint[]): Promise<SafetyHints["exactUnknown"]> {
    if (!v.opId) return [];
    try {
      const reported = await this.prisma.migrationRunHostReport.count({ where: { runId: { in: [v.id, ...(v.promotedFromId ? [v.promotedFromId] : [])] }, kind: "inventory", state: "complete" } });
      if (reported === 0) return [];
      const op = await this.prisma.bulkOperation.findUnique({ where: { id: v.opId }, select: { meta: true } });
      const meta = typeof op?.meta === "object" && op.meta ? (op.meta as ExactMeta) : {};
      const have = new Set(exactRows(hints).map((r) => (r.member ? `${r.itemRef}#${r.member}` : r.itemRef)));
      return exactCandidatesOf(meta)
        .filter((c) => !(c.image && isDigestPinned(c.image)) && !have.has(exactKeyOf(c)) && !isExactOff(hints, c.itemRef))
        .slice(0, 200)
        .map((c) => ({ itemRef: c.itemRef, member: c.member ?? "", image: (c.image ?? "").slice(0, 300) }));
    } catch {
      return [];
    }
  }

  private async load(user: AuthUser, id: string, acting: boolean) {
    const v = await this.prisma.migrationRun.findUnique({ where: { id }, select: { id: true, teamId: true, actorId: true, status: true, ponrAt: true, promotedFromId: true, opId: true } });
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

/** The stack members a dry run lists as floating, by hint key: the image the source writes and the version it shows for it. */
function listedMembers(steps: ReadonlyArray<{ progress: unknown }>): Map<string, { image: string; seen: string }> {
  const out = new Map<string, { image: string; seen: string }>();
  for (const w of warningsOf(steps)) {
    const items = w.params?.imageItems;
    const members = w.params?.imageMembers;
    const images = w.params?.images;
    const seen = w.params?.imageSeen;
    if (![items, members, images, seen].every((a) => Array.isArray(a))) continue;
    (items as unknown[]).forEach((itemRef, i) => {
      const member = (members as unknown[])[i];
      const image = (images as unknown[])[i];
      if (typeof itemRef === "string" && typeof member === "string" && member && typeof image === "string" && image) out.set(servicePinKey(itemRef, member), { image, seen: String((seen as unknown[])[i] ?? "") });
    });
  }
  return out;
}

function view(hints: readonly RunHint[], fixed: readonly string[] = [], exactUnknown: SafetyHints["exactUnknown"] = []): SafetyHints {
  return {
    imagePins: hints.filter((h) => h.kind === "image-pin").map((h) => ({ image: h.key, scope: h.scope, digest: h.value, evidence: h.evidence })),
    workerMarks: hints.filter((h) => h.kind === "worker-mark" && (h.value === "job-runner" || h.value === "web")).map((h) => ({ itemRef: h.key, role: h.value as "job-runner" | "web" })),
    warningAcks: hints.filter((h) => h.kind === "warning-ack" && h.value === "accepted").map((h) => h.key).sort(),
    servicePins: hints
      .filter((h) => h.kind === "service-pin")
      .map((h) => {
        const at = h.key.lastIndexOf("#");
        return { itemRef: h.key.slice(0, at), member: h.key.slice(at + 1), ref: h.value, evidence: h.evidence };
      })
      .sort((a, b) => (a.itemRef + a.member < b.itemRef + b.member ? -1 : 1)),
    exactImages: exactRows(hints),
    exactUnknown,
    warningsFixed: [...fixed],
  };
}

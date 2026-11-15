import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { UseGuards } from "@nestjs/common";
import { CsrfExempt } from "../../common/csrf-exempt.decorator";
import { AllowUnverified } from "../../common/allow-unverified.decorator";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { MigrationTokenGuard } from "../migration-token.guard";
import { MigrationOp } from "../migration-op.decorator";
import type { MigrationTokenContext } from "../migration-token.service";
import { VxService } from "./vx.service";
import {
  VxBeginBodySchema,
  VxFinishBodySchema,
  VxInventoryBodySchema,
  VxMigratorDiskCheckBodySchema,
  VxPartBodySchema,
  VxRunBodySchema,
  VxSpeedtestBodySchema,
  type VxBeginBody,
  type VxFinishBody,
  type VxInventoryBody,
  type VxMigratorDiskCheckBody,
  type VxPartBody,
  type VxRunBody,
  type VxSpeedtestBody,
} from "./vx.dto";

/**
 * The endpoints the untrusted SOURCE host calls for the streamed volume copy, authenticated ONLY by the migration token
 * (same guard and prefix as the v1 ingest controller). The opId comes from the token; every destination is resolved
 * server-side from the op's DONE provisioning tasks. `:itemRef` is the url-encoded `volume:...` ref. Excluded from the
 * OpenAPI document like the rest of the token surface.
 */
@ApiExcludeController()
@Controller("import/migration/vx")
@UseGuards(MigrationTokenGuard)
@Throttle({ default: { limit: 300, ttl: 60_000 } })
@CsrfExempt()
@AllowUnverified()
export class MigrationVolumeController {
  constructor(private readonly vx: VxService) {}

  /** Read-only inspection of the source volumes (size, entries, specials, running, Postgres image/major/layout). */
  @Post("inventory")
  inventory(@MigrationOp() op: MigrationTokenContext, @Body(new ZodValidationPipe(VxInventoryBodySchema)) body: VxInventoryBody) {
    return this.vx.inventory(op, body);
  }

  /** Dry-run size check of the target host against the inventory (or an explicit size). No data moves. */
  @Post(":itemRef/disk-check")
  diskCheck(@MigrationOp() op: MigrationTokenContext, @Param("itemRef") itemRef: string, @Body(new ZodValidationPipe(VxMigratorDiskCheckBodySchema)) body: VxMigratorDiskCheckBody) {
    return this.vx.diskCheck(op.opId, op.actorId, itemRef, body.rawBytes);
  }

  /** Claim (or resume) the transfer of one volume: gates, lease, source fingerprint, manifest of the committed parts. */
  @Post(":itemRef/begin")
  @HttpCode(200)
  begin(@MigrationOp() op: MigrationTokenContext, @Param("itemRef") itemRef: string, @Body(new ZodValidationPipe(VxBeginBodySchema)) body: VxBeginBody) {
    return this.vx.begin(op, itemRef, body);
  }

  /** Register part `idx`: returns the signed relay path to PUT it to (or alreadyDone / busy). */
  @Post(":itemRef/parts/:idx")
  @HttpCode(200)
  registerPart(
    @MigrationOp() op: MigrationTokenContext,
    @Param("itemRef") itemRef: string,
    @Param("idx", ParseIntPipe) idx: number,
    @Body(new ZodValidationPipe(VxPartBodySchema)) body: VxPartBody,
  ) {
    return this.vx.registerPart(op, itemRef, idx, body);
  }

  /** Wait for the target to confirm part `idx` (long-poll: `pending` means ask again). */
  @Post(":itemRef/parts/:idx/commit")
  @HttpCode(200)
  commitPart(
    @MigrationOp() op: MigrationTokenContext,
    @Param("itemRef") itemRef: string,
    @Param("idx", ParseIntPipe) idx: number,
    @Body(new ZodValidationPipe(VxRunBodySchema)) body: VxRunBody,
  ) {
    return this.vx.commitPart(op, itemRef, idx, body);
  }

  /** The last tar byte was sent: validate, re-check the destination and the target's space, start the apply. */
  @Post(":itemRef/finish")
  @HttpCode(202)
  finish(@MigrationOp() op: MigrationTokenContext, @Param("itemRef") itemRef: string, @Body(new ZodValidationPipe(VxFinishBodySchema)) body: VxFinishBody) {
    return this.vx.finish(op, itemRef, body);
  }

  /** What the migrator polls after finish. */
  @Get(":itemRef/status")
  status(@MigrationOp() op: MigrationTokenContext, @Param("itemRef") itemRef: string) {
    return this.vx.status(op, itemRef);
  }

  /** Renew the lease and the token during phases that make no other call. */
  @Post(":itemRef/beat")
  @HttpCode(200)
  beat(@MigrationOp() op: MigrationTokenContext, @Param("itemRef") itemRef: string, @Body(new ZodValidationPipe(VxRunBodySchema)) body: VxRunBody) {
    return this.vx.beat(op, itemRef, body);
  }

  /** Discard the staged parts and start the volume over (never automatic). */
  @Post(":itemRef/reset")
  @HttpCode(200)
  reset(@MigrationOp() op: MigrationTokenContext, @Param("itemRef") itemRef: string, @Body(new ZodValidationPipe(VxRunBodySchema)) body: VxRunBody) {
    return this.vx.reset(op, itemRef, body);
  }

  /** The migrator was interrupted: release the lease, keep the staged parts. */
  @Post(":itemRef/abort")
  @HttpCode(200)
  abort(@MigrationOp() op: MigrationTokenContext, @Param("itemRef") itemRef: string, @Body(new ZodValidationPipe(VxRunBodySchema)) body: VxRunBody) {
    return this.vx.abort(op, itemRef, body);
  }

  /** Link speed test (read-only for the source): register one throwaway part of the volume's first MiB. */
  @Post(":itemRef/speedtest/:idx")
  @HttpCode(200)
  speedtestPart(
    @MigrationOp() op: MigrationTokenContext,
    @Param("itemRef") itemRef: string,
    @Param("idx", ParseIntPipe) idx: number,
    @Body(new ZodValidationPipe(VxSpeedtestBodySchema)) body: VxSpeedtestBody,
  ) {
    return this.vx.speedtestPart(op, itemRef, idx, body);
  }

  /** Wait for the target to confirm the throwaway part; answers the hub-measured time. */
  @Post(":itemRef/speedtest/:idx/commit")
  @HttpCode(200)
  speedtestCommit(
    @MigrationOp() op: MigrationTokenContext,
    @Param("itemRef") itemRef: string,
    @Param("idx", ParseIntPipe) idx: number,
    @Body(new ZodValidationPipe(VxRunBodySchema)) body: VxRunBody,
  ) {
    return this.vx.speedtestCommit(op, itemRef, idx, body);
  }

  /** End the test: remove its throwaway staging on the target. */
  @Post(":itemRef/speedtest-end")
  @HttpCode(200)
  speedtestEnd(@MigrationOp() op: MigrationTokenContext, @Param("itemRef") itemRef: string, @Body(new ZodValidationPipe(VxRunBodySchema)) body: VxRunBody) {
    return this.vx.speedtestEnd(op, itemRef, body);
  }
}

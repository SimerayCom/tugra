import { Body, Controller, Param, Post } from "@nestjs/common";
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
import { VxInventoryBodySchema, VxMigratorDiskCheckBodySchema, type VxInventoryBody, type VxMigratorDiskCheckBody } from "./vx.dto";

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
}

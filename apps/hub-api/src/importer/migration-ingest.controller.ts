import { Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Readable } from "node:stream";
import { CsrfExempt } from "../common/csrf-exempt.decorator";
import { AllowUnverified } from "../common/allow-unverified.decorator";
import { MigrationTokenGuard } from "./migration-token.guard";
import { MigrationOp } from "./migration-op.decorator";
import type { MigrationTokenContext } from "./migration-token.service";
import { MigrationIngestService } from "./migration-ingest.service";

type IngestReq = Readable & { headers: Record<string, string | string[] | undefined> };

/**
 * The endpoints the untrusted SOURCE host calls during a one-click migration, authenticated ONLY by the
 * migration token (not a user/PAT). The opId comes ONLY from the token (@MigrationOp); every destination is
 * resolved server-side from the op's DONE provisioning tasks, so a spoofed ?opId / body / param is ignored.
 * S3 ships the DB data plane: enumerate targets, PUT an artifact to hub staging, POST to restore it, and poll
 * status. Volume ingest is gated to S7 (501). The signed download the agent fetches lives on a separate
 * unguarded controller (MigrationArtifactController).
 */
@ApiExcludeController()
@Controller("import/migration")
@UseGuards(MigrationTokenGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@CsrfExempt()
@AllowUnverified()
export class MigrationIngestController {
  constructor(private readonly ingest: MigrationIngestService) {}

  /** Preflight: the migrator checks its token resolves before dumping any data. */
  @Get("probe")
  probe(@MigrationOp() op: MigrationTokenContext) {
    return { ok: true, opId: op.opId, expiresAt: op.expiresAt };
  }

  /** The data destinations this op provisioned (no resource ids / credentials / urls). */
  @Get("targets")
  targets(@MigrationOp() op: MigrationTokenContext) {
    return this.ingest.listTargets(op);
  }

  /** Stream a DB dump (octet-stream body) to hub staging; the hub returns its OWN byte count + sha256. */
  @Put("artifacts/:itemRef")
  @HttpCode(201)
  putArtifact(
    @MigrationOp() op: MigrationTokenContext,
    @Param("itemRef") itemRef: string,
    @Query("gzip") gzip: string,
    @Query("format") format: string,
    @Req() req: IngestReq,
  ) {
    return this.ingest.stage(op, itemRef, req, { gzip: gzip !== "0", format });
  }

  /** Restore the staged artifact into the provisioned DB (destructive, gated, idempotent). 202 + poll status. */
  @Post("artifacts/:itemRef/restore")
  @HttpCode(202)
  restore(@MigrationOp() op: MigrationTokenContext, @Param("itemRef") itemRef: string, @Query("resync") resync: string) {
    return this.ingest.restore(op, itemRef, { resync: resync === "1" });
  }

  /** Coarse restore state for the source host to poll. */
  @Get("artifacts/:itemRef/status")
  status(@MigrationOp() op: MigrationTokenContext, @Param("itemRef") itemRef: string) {
    return this.ingest.status(op, itemRef);
  }

  /** Volume ingest is not implemented until S7 (the app must first declare the volume). */
  @Post("artifacts/:itemRef/volumes/:volumeName")
  @HttpCode(501)
  volume() {
    return { code: "volume-ingest-disabled", requires: "S7" };
  }
}

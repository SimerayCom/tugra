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
 * S3 ships the DB data plane and P3 the app-volume data plane: enumerate targets, PUT an artifact (DB dump or
 * one volume's tarball) to hub staging, POST to restore it, and poll status. The signed download the agent
 * fetches lives on a separate unguarded controller (MigrationArtifactController).
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

  /** The per-engine dump recipes the source host runs, and the engines it cannot stream (skip explicitly).
   *  Token-guarded (controller guard), op-independent, and secret-free — the commands carry no credential. */
  @Get("recipes")
  recipes() {
    return this.ingest.recipes();
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

  /** Stream a gzip tarball of ONE declared app volume to hub staging; the hub records its OWN bytes + sha256. */
  @Put("artifacts/:itemRef/volumes/:volumeName")
  @HttpCode(201)
  putVolume(
    @MigrationOp() op: MigrationTokenContext,
    @Param("itemRef") itemRef: string,
    @Param("volumeName") volumeName: string,
    @Query("gzip") gzip: string,
    @Req() req: IngestReq,
  ) {
    return this.ingest.stageVolume(op, itemRef, volumeName, req, { gzip: gzip !== "0" });
  }

  /** Restore a staged volume tarball into the app's docker volume (destructive wipe+extract, gated). 202 + poll. */
  @Post("artifacts/:itemRef/volumes/:volumeName/restore")
  @HttpCode(202)
  restoreVolume(
    @MigrationOp() op: MigrationTokenContext,
    @Param("itemRef") itemRef: string,
    @Param("volumeName") volumeName: string,
    @Query("resync") resync: string,
  ) {
    return this.ingest.restoreVolume(op, itemRef, volumeName, { resync: resync === "1" });
  }

  /** Coarse per-volume restore state for the source host to poll. */
  @Get("artifacts/:itemRef/volumes/:volumeName/status")
  volumeStatus(@MigrationOp() op: MigrationTokenContext, @Param("itemRef") itemRef: string, @Param("volumeName") volumeName: string) {
    return this.ingest.volumeStatus(op, itemRef, volumeName);
  }
}

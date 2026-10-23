import { Controller, Get, Header, Param, Query, StreamableFile } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CsrfExempt } from "../common/csrf-exempt.decorator";
import { AllowUnverified } from "../common/allow-unverified.decorator";
import { MigrationIngestService } from "./migration-ingest.service";

/**
 * Serves ONE staged migration artifact to the TARGET agent's `curl` during a restore. Deliberately
 * UNGUARDED by the migration token (the agent is not the source host and holds no token) — the only auth is
 * the HMAC in the query, which binds opId + taskId + the hub-computed content sha256 + a 15-min expiry, and
 * the file is served only while the sibling restore task is RUNNING. Every failure is a uniform 404, the URL
 * is never logged, and the response is no-store. @CsrfExempt/@AllowUnverified because there is no cookie/user.
 */
@ApiExcludeController()
@Controller("import/migration/dl")
@CsrfExempt()
@AllowUnverified()
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class MigrationArtifactController {
  constructor(private readonly ingest: MigrationIngestService) {}

  @Get(":file")
  @Header("Cache-Control", "no-store")
  download(@Param("file") file: string, @Query("exp") exp: string, @Query("sig") sig: string): Promise<StreamableFile> {
    return this.ingest.serveArtifact(file, exp, sig);
  }
}

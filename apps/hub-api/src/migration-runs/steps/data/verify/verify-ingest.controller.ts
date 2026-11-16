import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CsrfExempt } from "../../../../common/csrf-exempt.decorator";
import { AllowUnverified } from "../../../../common/allow-unverified.decorator";
import { MigrationTokenGuard } from "../../../../importer/migration-token.guard";
import { MigrationOp } from "../../../../importer/migration-op.decorator";
import type { MigrationTokenContext } from "../../../../importer/migration-token.service";
import { VerifyIngestService } from "./verify-ingest.service";

/**
 * `tugra-agent migrate --verify` reports here (authenticated ONLY by the migration token, like the rest of
 * `/import/migration/*`). The opId comes from the token alone; the body is validated strictly by the service.
 */
@ApiExcludeController()
@Controller("import/migration/verify")
@UseGuards(MigrationTokenGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@CsrfExempt()
@AllowUnverified()
export class VerifyIngestController {
  constructor(private readonly ingest: VerifyIngestService) {}

  @Post()
  @HttpCode(200)
  report(@MigrationOp() op: MigrationTokenContext, @Body() body: unknown) {
    return this.ingest.ingest(op, body);
  }
}

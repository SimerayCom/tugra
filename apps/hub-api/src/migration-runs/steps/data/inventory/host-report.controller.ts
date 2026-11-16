import { Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Readable } from "node:stream";
import { CsrfExempt } from "../../../../common/csrf-exempt.decorator";
import { AllowUnverified } from "../../../../common/allow-unverified.decorator";
import { MigrationTokenGuard } from "../../../../importer/migration-token.guard";
import { MigrationOp } from "../../../../importer/migration-op.decorator";
import type { MigrationTokenContext } from "../../../../importer/migration-token.service";
import { HostReportService, countBody, readTextBody } from "./host-report.service";
import { REPORT_MAX_BYTES } from "./host-protocol";

type RawReq = Readable & { headers: Record<string, string | string[] | undefined> };

/**
 * What the source-host scripts (the `coolify-host-loop` script and `migrator.sh --inventory`) call, authenticated ONLY by the
 * migration token like the rest of `/import/migration/*`:
 *  - `POST host-report` (`text/plain`, 1 MiB): the labelled report lines (loop status, inventory, reach, freeze);
 *  - `GET host-probe/ping`: reachability + the hub's configured part size, so a source can test the path with the size it needs;
 *  - `POST host-probe/sink`: counts and discards a raw upload (the body-cap probe; never stored, never buffered).
 */
@ApiExcludeController()
@Controller("import/migration")
@UseGuards(MigrationTokenGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@CsrfExempt()
@AllowUnverified()
export class HostReportController {
  constructor(private readonly reports: HostReportService) {}

  @Post("host-report")
  @HttpCode(200)
  async report(@MigrationOp() op: MigrationTokenContext, @Req() req: RawReq) {
    return this.reports.ingest(op, await readTextBody(req, REPORT_MAX_BYTES));
  }

  @Get("host-probe/ping")
  ping() {
    return this.reports.ping();
  }

  @Post("host-probe/sink")
  @HttpCode(200)
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  async sink(@Req() req: RawReq) {
    return { received: await countBody(req, this.reports.probeCap) };
  }
}

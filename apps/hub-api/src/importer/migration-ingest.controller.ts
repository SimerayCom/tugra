import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CsrfExempt } from "../common/csrf-exempt.decorator";
import { AllowUnverified } from "../common/allow-unverified.decorator";
import { MigrationTokenGuard } from "./migration-token.guard";
import { MigrationOp } from "./migration-op.decorator";
import type { MigrationTokenContext } from "./migration-token.service";

/**
 * The endpoints the untrusted SOURCE host calls during a one-click migration, authenticated ONLY by the
 * migration token (not a user/PAT) — kept on a separate controller because {@link ImporterController}'s
 * class-level ApiAuthGuard+ScopesGuard would demand a session. Public-caller conventions: own throttle,
 * CSRF-exempt (header-token, no cookies), email-verification irrelevant, excluded from the OpenAPI/PAT
 * contract. S2 ships only the preflight probe; artifact ingest (size/SSRF/dest-binding) is S3.
 */
@ApiExcludeController()
@Controller("import/migration")
@UseGuards(MigrationTokenGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@CsrfExempt()
@AllowUnverified()
export class MigrationIngestController {
  /** Preflight: the migrator checks its token resolves before dumping any data. Reveals only the token holder's own op. */
  @Get("probe")
  probe(@MigrationOp() op: MigrationTokenContext) {
    return { ok: true, opId: op.opId, expiresAt: op.expiresAt };
  }
}

import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../../../agent-gateway/agent-gateway.module";
import { CryptoModule } from "../../../crypto/crypto.module";
import { CutoverModule } from "../../../cutover/cutover.module";
import { ImporterModule } from "../../../importer/importer.module";
import { MigrationTokenGuard } from "../../../importer/migration-token.guard";
import { MigrationTokenService } from "../../../importer/migration-token.service";
import { ObjectMigrationsModule } from "../../../object-migrations/object-migrations.module";
import { ServersModule } from "../../../servers/servers.module";
import { ServerCapabilityPort } from "./adapters/capability.adapter";
import { PrismaDataPort } from "./adapters/data-port.adapter";
import { TargetDbStats } from "./adapters/db-stats.adapter";
import { ImporterDrift } from "./adapters/drift.adapter";
import { CutoverFlipPlans } from "./adapters/flip-plan.adapter";
import { ObjectMigrationPort } from "./adapters/object-port.adapter";
import { PrismaRuntime } from "./adapters/runtime.adapter";
import { CoolifySourceApi } from "./adapters/source-api.adapter";
import { AgentSourceHost } from "./adapters/source-host.adapter";
import { DataFinalHandler } from "./data-final.handler";
import { DataSeedHandler } from "./data-seed.handler";
import { CAPABILITY_PORT, CHECK_STORE, DATA_PORT, DB_STATS_PORT, DRIFT_PORT, FLIP_PLAN_PORT, OBJECT_PORT, RUNTIME_PORT, SOURCE_API_PORT, SOURCE_HOST_PORT } from "./data-contract";
import { FreezeHandler } from "./freeze.handler";
import { MigratorRunner } from "./launcher/migrator-runner.service";
import { PrismaCheckStore } from "./verify/check-store";
import { VerifyIngestController } from "./verify/verify-ingest.controller";
import { VerifyIngestService } from "./verify/verify-ingest.service";
import { VerifyHandler } from "./verify.handler";

/**
 * Lane B of the one-click migration orchestrator: the DATA_SEED, FREEZE, DATA_FINAL and VERIFY step handlers, which register
 * themselves with the global `STEP_HANDLERS` registry in `onModuleInit` (the core module imports this module and never names a
 * handler). Everything the handlers touch is behind a port (`data-contract.ts`); the adapters below bind those ports to the
 * existing services: importer executor + Prisma (data plane), the object-migration service, the agent gateway (same-host
 * scripts, DB statistics), the Coolify control client, the servers service (the opt-in `migrate` capability) and the cutover
 * service (the flip plan the point-of-no-return approval is bound to).
 *
 * It also owns one token-authenticated route, `POST /import/migration/verify`, where `tugra-agent migrate --verify` reports the
 * SOURCE side of DB parity. The token guard's two providers have no other dependencies than the global Prisma/Audit modules,
 * so they are provided here again rather than widening the importer module's exports.
 */
@Module({
  imports: [AgentGatewayModule, CryptoModule, ImporterModule, CutoverModule, ObjectMigrationsModule, ServersModule],
  controllers: [VerifyIngestController],
  providers: [
    MigrationTokenService,
    MigrationTokenGuard,
    VerifyIngestService,
    MigratorRunner,
    PrismaDataPort,
    ObjectMigrationPort,
    AgentSourceHost,
    CoolifySourceApi,
    ServerCapabilityPort,
    PrismaCheckStore,
    TargetDbStats,
    PrismaRuntime,
    CutoverFlipPlans,
    ImporterDrift,
    { provide: DATA_PORT, useExisting: PrismaDataPort },
    { provide: OBJECT_PORT, useExisting: ObjectMigrationPort },
    { provide: SOURCE_HOST_PORT, useExisting: AgentSourceHost },
    { provide: SOURCE_API_PORT, useExisting: CoolifySourceApi },
    { provide: CAPABILITY_PORT, useExisting: ServerCapabilityPort },
    { provide: CHECK_STORE, useExisting: PrismaCheckStore },
    { provide: DB_STATS_PORT, useExisting: TargetDbStats },
    { provide: RUNTIME_PORT, useExisting: PrismaRuntime },
    { provide: FLIP_PLAN_PORT, useExisting: CutoverFlipPlans },
    { provide: DRIFT_PORT, useExisting: ImporterDrift },
    DataSeedHandler,
    FreezeHandler,
    DataFinalHandler,
    VerifyHandler,
  ],
  exports: [CHECK_STORE, DATA_PORT],
})
export class RunDataStepsModule {}

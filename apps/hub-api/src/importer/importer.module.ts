import { Module } from "@nestjs/common";
import { MigratorModule } from "../migrator/migrator.module";
import { CryptoModule } from "../crypto/crypto.module";
import { ApplicationsModule } from "../applications/applications.module";
import { DatabasesModule } from "../databases/databases.module";
import { GitSourcesModule } from "../git-sources/git-sources.module";
import { ProjectsModule } from "../projects/projects.module";
import { CutoverCertService } from "../cutover/cutover-cert.service";
import { BackupsModule } from "../backups/backups.module";
import { VolumeBackupsModule } from "../volume-backups/volume-backups.module";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { AppMovesModule } from "../app-moves/app-moves.module";
import { ImporterController } from "./importer.controller";
import { MigrationIngestController } from "./migration-ingest.controller";
import { MigrationArtifactController } from "./migration-artifact.controller";
import { ImporterService } from "./importer.service";
import { ImportExecutorService } from "./import-executor.service";
import { GitLinkResolverService } from "./git-link-resolver.service";
import { ImportGitLinksService } from "./import-git-links.service";
import { ImportMappingService } from "./import-mapping.service";
import { MigrationTokenService } from "./migration-token.service";
import { MigrationTokenGuard } from "./migration-token.guard";
import { MigrationIngestService } from "./migration-ingest.service";
import { MigrationVolumeController } from "./volume-stream/vx.controller";
import { VxService } from "./volume-stream/vx.service";
import { VxApplyService } from "./volume-stream/vx-apply.service";
import { VxRecoveryService } from "./volume-stream/vx-recovery.service";
import { VxPartRegistry } from "./volume-stream/vx-part-registry";
import { CoolifyClientFactory } from "./sources/coolify-client.factory";
import { DokployClientFactory } from "./sources/dokploy-client.factory";
import { CaproverClientFactory } from "./sources/caprover-client.factory";
import { ImportSourceFactory } from "./sources/import-source.factory";
import { EgressIpService } from "./egress-ip.service";
import { ImportSettingsService } from "./settings/import-settings.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { DestinationsModule } from "../destinations/destinations.module";
import { SharedVariablesModule } from "../shared-variables/shared-variables.module";
import { ScheduledTasksModule } from "../scheduled-tasks/scheduled-tasks.module";
import { ServerOpsModule } from "../server-ops/server-ops.module";
import { TeamsModule } from "../teams/teams.module";
import { CoolifyTakeoverModule } from "../coolify-takeover/coolify-takeover.module";
import { AgentCoolifyReader } from "./agent-coolify.reader";
import { AgentSecretsAdapter } from "./agent-secrets.adapter";

// Reuses MigratorService (MigratorModule) for local-docker adopt/unadopt, ApplicationsService
// (ApplicationsModule) to create/remove apps and DatabasesService (DatabasesModule) to provision
// databases for the remote-source copy executor, and CryptoService (CryptoModule) for the session token at
// rest. PrismaService, TeamAccessService and AuditService are provided by @Global modules.
// ImportSourceFactory maps a source kind → its adapter (it depends on CoolifyClientFactory).
@Module({
  imports: [MigratorModule, CryptoModule, ApplicationsModule, DatabasesModule, BackupsModule, VolumeBackupsModule, GitSourcesModule, ProjectsModule, AgentGatewayModule, AppMovesModule, NotificationsModule, DestinationsModule, SharedVariablesModule, ScheduledTasksModule, ServerOpsModule, TeamsModule, CoolifyTakeoverModule],
  controllers: [ImporterController, MigrationIngestController, MigrationArtifactController, MigrationVolumeController],
  providers: [ImporterService, ImportExecutorService, GitLinkResolverService, ImportGitLinksService, MigrationTokenService, MigrationTokenGuard, MigrationIngestService, EgressIpService, CoolifyClientFactory, DokployClientFactory, CaproverClientFactory, ImportSourceFactory, AgentCoolifyReader, CutoverCertService, ImportMappingService, VxService, VxApplyService, VxRecoveryService, VxPartRegistry, ImportSettingsService, AgentSecretsAdapter],
  exports: [ImporterService, ImportExecutorService, CutoverCertService, ImportMappingService], // the MCP server wraps these as import_* tools
})
export class ImporterModule {}

import { Module } from "@nestjs/common";
import { MigratorModule } from "../migrator/migrator.module";
import { CryptoModule } from "../crypto/crypto.module";
import { ApplicationsModule } from "../applications/applications.module";
import { DatabasesModule } from "../databases/databases.module";
import { GitSourcesModule } from "../git-sources/git-sources.module";
import { ProjectsModule } from "../projects/projects.module";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { CutoverCertService } from "../cutover/cutover-cert.service";
import { BackupsModule } from "../backups/backups.module";
import { VolumeBackupsModule } from "../volume-backups/volume-backups.module";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
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
import { CoolifyClientFactory } from "./sources/coolify-client.factory";
import { DokployClientFactory } from "./sources/dokploy-client.factory";
import { ImportSourceFactory } from "./sources/import-source.factory";

// Reuses MigratorService (MigratorModule) for local-docker adopt/unadopt, ApplicationsService
// (ApplicationsModule) to create/remove apps and DatabasesService (DatabasesModule) to provision
// databases for the remote-source copy executor, and CryptoService (CryptoModule) for the session token at
// rest. PrismaService, TeamAccessService and AuditService are provided by @Global modules.
// ImportSourceFactory maps a source kind → its adapter (it depends on CoolifyClientFactory).
@Module({
  imports: [MigratorModule, CryptoModule, ApplicationsModule, DatabasesModule, BackupsModule, VolumeBackupsModule, GitSourcesModule, ProjectsModule, AgentGatewayModule],
  controllers: [ImporterController, MigrationIngestController, MigrationArtifactController, MigrationVolumeController],
  providers: [ImporterService, ImportExecutorService, GitLinkResolverService, ImportGitLinksService, MigrationTokenService, MigrationTokenGuard, MigrationIngestService, CoolifyClientFactory, DokployClientFactory, ImportSourceFactory, CutoverCertService, ImportMappingService, VxService],
  exports: [ImporterService, ImportExecutorService, CutoverCertService, ImportMappingService], // the MCP server wraps these as import_* tools
})
export class ImporterModule {}

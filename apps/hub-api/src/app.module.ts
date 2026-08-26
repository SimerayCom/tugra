import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { JwtModule } from "@nestjs/jwt";
import { validateEnv } from "./config/env";
import { CsrfGuard } from "./common/csrf.guard";
import { EmailVerifiedGuard } from "./common/email-verified.guard";
import { HealthController } from "./health/health.controller";
import { VersionController } from "./health/version.controller";
import { InstanceController } from "./instance/instance.controller";
import { InstanceSettingsController } from "./instance/instance-settings.controller";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { AuditModule } from "./audit/audit.module";
import { InstanceSettingsModule } from "./instance/instance-settings.module";
import { TeamAccessModule } from "./common/team-access.module";
import { MailModule } from "./mail/mail.module";
import { AuthModule } from "./auth/auth.module";
import { ServersModule } from "./servers/servers.module";
import { AgentGatewayModule } from "./agent-gateway/agent-gateway.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { MonitorsModule } from "./monitors/monitors.module";
import { BulkModule } from "./bulk/bulk.module";
import { AgentUpdateModule } from "./agent-update/agent-update.module";
import { ApplicationsModule } from "./applications/applications.module";
import { DatabasesModule } from "./databases/databases.module";
import { BackupsModule } from "./backups/backups.module";
import { VolumeBackupsModule } from "./volume-backups/volume-backups.module";
import { DestinationsModule } from "./destinations/destinations.module";
import { ServerOpsModule } from "./server-ops/server-ops.module";
import { MigratorModule } from "./migrator/migrator.module";
import { CloudModule } from "./cloud/cloud.module";
import { TunnelModule } from "./tunnel/tunnel.module";
import { ApiTokensModule } from "./api-tokens/api-tokens.module";
import { SavedViewsModule } from "./saved-views/saved-views.module";
import { SharedVariablesModule } from "./shared-variables/shared-variables.module";
import { GitSourcesModule } from "./git-sources/git-sources.module";
import { RegistriesModule } from "./registries/registries.module";
import { ProjectsModule } from "./projects/projects.module";
import { TeamsModule } from "./teams/teams.module";
import { ScheduledTasksModule } from "./scheduled-tasks/scheduled-tasks.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { ExpiryModule } from "./expiry/expiry.module";
import { RetentionModule } from "./retention/retention.module";
import { CatalogModule } from "./catalog/catalog.module";
import { UpdateModule } from "./update/update.module";
import { InstallController } from "./install/install.controller";
import { CryptoModule } from "./crypto/crypto.module";
import { LicenseModule } from "./license/license.module";
import { ClustersModule } from "./clusters/clusters.module";
import { McpModule } from "./mcp/mcp.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 120 }]),
    JwtModule.register({}), // for EmailVerifiedGuard to verify the access token itself
    PrismaModule,
    RedisModule,
    AuditModule,
    InstanceSettingsModule,
    TeamAccessModule,
    MailModule,
    AuthModule,
    ServersModule,
    AgentGatewayModule,
    NotificationsModule,
    MonitorsModule,
    BulkModule,
    AgentUpdateModule,
    ApplicationsModule,
    DatabasesModule,
    BackupsModule,
    VolumeBackupsModule,
    DestinationsModule,
    ServerOpsModule,
    MigratorModule,
    CloudModule,
    TunnelModule,
    ApiTokensModule,
    SavedViewsModule,
    SharedVariablesModule,
    GitSourcesModule,
    RegistriesModule,
    ProjectsModule,
    TeamsModule,
    ScheduledTasksModule,
    WebhooksModule,
    ExpiryModule,
    RetentionModule,
    CatalogModule,
    UpdateModule,
    CryptoModule, // for InstanceSettingsController to encrypt the OIDC client secret
    LicenseModule, // verifies the signed license at boot + backs the /instance/license endpoints
    ClustersModule, // team-scoped server groups (fleet organization + health rollup)
    McpModule, // read-only MCP server (Phase1) — AI-agent management over the same team-scoped services
  ],
  controllers: [HealthController, VersionController, InstanceController, InstanceSettingsController, InstallController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: EmailVerifiedGuard },
  ],
})
export class AppModule {}

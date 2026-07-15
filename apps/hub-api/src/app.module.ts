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
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { AuditModule } from "./audit/audit.module";
import { TeamAccessModule } from "./common/team-access.module";
import { MailModule } from "./mail/mail.module";
import { AuthModule } from "./auth/auth.module";
import { ServersModule } from "./servers/servers.module";
import { AgentGatewayModule } from "./agent-gateway/agent-gateway.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { MonitorsModule } from "./monitors/monitors.module";
import { BulkModule } from "./bulk/bulk.module";
import { ApplicationsModule } from "./applications/applications.module";
import { DatabasesModule } from "./databases/databases.module";
import { BackupsModule } from "./backups/backups.module";
import { VolumeBackupsModule } from "./volume-backups/volume-backups.module";
import { DestinationsModule } from "./destinations/destinations.module";
import { ServerOpsModule } from "./server-ops/server-ops.module";
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 120 }]),
    JwtModule.register({}), // for EmailVerifiedGuard to verify the access token itself
    PrismaModule,
    RedisModule,
    AuditModule,
    TeamAccessModule,
    MailModule,
    AuthModule,
    ServersModule,
    AgentGatewayModule,
    NotificationsModule,
    MonitorsModule,
    BulkModule,
    ApplicationsModule,
    DatabasesModule,
    BackupsModule,
    VolumeBackupsModule,
    DestinationsModule,
    ServerOpsModule,
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
  ],
  controllers: [HealthController, VersionController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: EmailVerifiedGuard },
  ],
})
export class AppModule {}

import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { JwtModule } from "@nestjs/jwt";
import { validateEnv } from "./config/env";
import { CsrfGuard } from "./common/csrf.guard";
import { EmailVerifiedGuard } from "./common/email-verified.guard";
import { TwoFactorRequiredGuard } from "./common/two-factor-required.guard";
import { HealthController } from "./health/health.controller";
import { VersionController } from "./health/version.controller";
import { InstanceController } from "./instance/instance.controller";
import { InstanceSettingsController } from "./instance/instance-settings.controller";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { AuditModule } from "./audit/audit.module";
import { InstanceSettingsModule } from "./instance/instance-settings.module";
import { ProxyConfigModule } from "./proxy-config/proxy-config.module";
import { TeamAccessModule } from "./common/team-access.module";
import { MailModule } from "./mail/mail.module";
import { AuthModule } from "./auth/auth.module";
import { ServersModule } from "./servers/servers.module";
import { AgentGatewayModule } from "./agent-gateway/agent-gateway.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { PushModule } from "./push/push.module";
import { MonitorsModule } from "./monitors/monitors.module";
import { StatusPageModule } from "./status-page/status-page.module";
import { KumaImportModule } from "./monitors/kuma/kuma-import.module";
import { CoolifyTakeoverModule } from "./coolify-takeover/coolify-takeover.module";
import { BulkModule } from "./bulk/bulk.module";
import { RolloutsModule } from "./rollouts/rollouts.module";
import { AgentUpdateModule } from "./agent-update/agent-update.module";
import { ApplicationsModule } from "./applications/applications.module";
import { AppMovesModule } from "./app-moves/app-moves.module";
import { ObjectMigrationsModule } from "./object-migrations/object-migrations.module";
import { FilesModule } from "./files/files.module";
import { DatabasesModule } from "./databases/databases.module";
import { BackupsModule } from "./backups/backups.module";
import { HubBackupModule } from "./hub-backup/hub-backup.module";
import { VolumeBackupsModule } from "./volume-backups/volume-backups.module";
import { DestinationsModule } from "./destinations/destinations.module";
import { ServerOpsModule } from "./server-ops/server-ops.module";
import { MigratorModule } from "./migrator/migrator.module";
import { ImporterModule } from "./importer/importer.module";
import { BeszelImportModule } from "./beszel-import/beszel-import.module";
import { MigrationRunsModule } from "./migration-runs/migration-runs.module";
import { MigrationSafetyModule } from "./migration-safety/migration-safety.module";
import { CutoverModule } from "./cutover/cutover.module";
import { CloudModule } from "./cloud/cloud.module";
import { CostsModule } from "./costs/costs.module";
import { TunnelModule } from "./tunnel/tunnel.module";
import { DnsModule } from "./dns/dns.module";
import { SecretProvidersModule } from "./secret-providers/secret-providers.module";
import { ApiTokensModule } from "./api-tokens/api-tokens.module";
import { SavedViewsModule } from "./saved-views/saved-views.module";
import { DashboardModule } from "./dashboard/dashboard.module";
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
import { TelemetryModule } from "./telemetry/telemetry.module";
import { InstallController } from "./install/install.controller";
import { CryptoModule } from "./crypto/crypto.module";
import { LicenseModule } from "./license/license.module";
import { ClustersModule } from "./clusters/clusters.module";
import { McpModule } from "./mcp/mcp.module";
import { ApiRateLimitInterceptor } from "./api-tokens/api-rate-limit.interceptor";
import { AuditContextInterceptor } from "./audit/audit-context.interceptor";
import { PortalSurfaceInterceptor } from "./common/portal-surface.interceptor";
import { IdempotencyInterceptor } from "./common/idempotency.interceptor";
import { PaginationInterceptor } from "./common/pagination.interceptor";
import { ApiExceptionFilter } from "./common/api-exception.filter";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Global HTTP rate limit, configurable via THROTTLE_TTL_MS / THROTTLE_LIMIT (defaults 60s / 120 req).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          name: "default",
          ttl: config.get<number>("THROTTLE_TTL_MS") ?? 60_000,
          limit: config.get<number>("THROTTLE_LIMIT") ?? 120,
        },
      ],
    }),
    JwtModule.register({}), // for EmailVerifiedGuard to verify the access token itself
    PrismaModule,
    RedisModule,
    AuditModule,
    InstanceSettingsModule,
    ProxyConfigModule,
    TeamAccessModule,
    MailModule,
    AuthModule,
    ServersModule,
    AgentGatewayModule,
    NotificationsModule,
    PushModule,
    MonitorsModule,
    StatusPageModule, // public per-team status pages + RSS/email subscribe
    KumaImportModule,
    CoolifyTakeoverModule,
    BulkModule,
    RolloutsModule,
    AgentUpdateModule,
    ApplicationsModule,
    AppMovesModule, // move an app (same id, data included) to another server
    ObjectMigrationsModule, // S3/MinIO bucket mirror (mc) run by the target agent
    FilesModule,
    DatabasesModule,
    BackupsModule,
    HubBackupModule,
    VolumeBackupsModule,
    DestinationsModule,
    ServerOpsModule,
    MigratorModule,
    ImporterModule, // fleet importer (Coolify / local Docker)
    BeszelImportModule, // Beszel hub import (systems, alert rules, channels, history)
    CutoverModule, // SSL/DNS cutover of imported apps
    MigrationRunsModule, // one-click migration orchestrator (P7)
    MigrationSafetyModule, // verification report + pre-migration snapshot (92, 93)
    CloudModule,
    CostsModule,
    TunnelModule,
    DnsModule,
    SecretProvidersModule,
    ApiTokensModule,
    SavedViewsModule,
    DashboardModule,
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
    TelemetryModule, // anonymous usage stats (on by default, opt-out) + the owner /instance/telemetry endpoints
    CryptoModule, // for InstanceSettingsController to encrypt the OIDC client secret
    LicenseModule, // verifies the signed license at boot + backs the /instance/license endpoints
    ClustersModule, // team-scoped server groups (fleet organization + health rollup)
    McpModule, // read-only MCP server — AI-agent management over the same team-scoped services
  ],
  controllers: [HealthController, VersionController, InstanceController, InstanceSettingsController, InstallController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: EmailVerifiedGuard },
    // Instance policy "Require 2FA for owners/admins": an un-enrolled owner/admin only reaches account self-service.
    { provide: APP_GUARD, useClass: TwoFactorRequiredGuard },
    // Per-PAT rate limit (X-RateLimit-* + Retry-After); runs after the auth guard so req.user.tokenId is set.
    { provide: APP_INTERCEPTOR, useClass: ApiRateLimitInterceptor },
    // Customer portal: marks whether the request is on the Client surface (memberships of a Client role are
    // invisible to every other route; see common/portal-surface.ts).
    { provide: APP_INTERCEPTOR, useClass: PortalSurfaceInterceptor },
    // Establishes the per-request audit auth-context (pat+tokenId | session) that AuditService.log stamps.
    { provide: APP_INTERCEPTOR, useClass: AuditContextInterceptor },
    // Idempotency-Key replay for POSTs (closest-but-one to the handler it dedupes).
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    // Opt-in ?limit/?cursor pagination for @Paginated() list handlers; innermost, so it slices only the
    // handler's (already-authorized, already-redacted) array output.
    { provide: APP_INTERCEPTOR, useClass: PaginationInterceptor },
    // Normalize every thrown error to the single { statusCode, error, message } ApiError shape.
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}

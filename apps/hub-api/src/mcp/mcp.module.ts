import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ApplicationsModule } from "../applications/applications.module";
import { ServersModule } from "../servers/servers.module";
import { ClustersModule } from "../clusters/clusters.module";
import { DatabasesModule } from "../databases/databases.module";
import { BackupsModule } from "../backups/backups.module";
import { MonitorsModule } from "../monitors/monitors.module";
import { ImporterModule } from "../importer/importer.module";
import { MetricsModule } from "../metrics/metrics.module";
import { SecretProvidersModule } from "../secret-providers/secret-providers.module";
import { DnsModule } from "../dns/dns.module";
import { TunnelModule } from "../tunnel/tunnel.module";
import { CloudModule } from "../cloud/cloud.module";
import { ServerOpsModule } from "../server-ops/server-ops.module";
import { MigrationRunsModule } from "../migration-runs/migration-runs.module";
import { CoolifyMoveModule } from "../coolify-move/coolify-move.module";
import { McpController } from "./mcp.controller";
import { McpService } from "./mcp.service";
import { escapeJsonLineSeparators } from "./json-line-separators";

/**
 * MCP server (read + PAT-scoped mutate). Imports the domain modules whose services the tool catalog calls;
 * ApiTokens (guards), Redis and Audit are @Global. Every tool — read or mutate — goes through the same
 * team-scoped service methods (with their own permission checks + audit) that the REST controllers use, so
 * MCP adds no new authorization path; it is a JSON-RPC surface over the existing capabilities.
 */
@Module({
  imports: [ApplicationsModule, ServersModule, ClustersModule, DatabasesModule, BackupsModule, MonitorsModule, ImporterModule, MetricsModule, SecretProvidersModule, DnsModule, TunnelModule, MigrationRunsModule, ServerOpsModule, CloudModule, CoolifyMoveModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Tool output is free text: keep raw U+2028/U+2029 off the wire (see json-line-separators.ts).
    consumer.apply(escapeJsonLineSeparators).forRoutes(McpController);
  }
}

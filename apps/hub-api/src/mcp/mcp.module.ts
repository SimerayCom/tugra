import { Module } from "@nestjs/common";
import { ApplicationsModule } from "../applications/applications.module";
import { ServersModule } from "../servers/servers.module";
import { ClustersModule } from "../clusters/clusters.module";
import { DatabasesModule } from "../databases/databases.module";
import { BackupsModule } from "../backups/backups.module";
import { MonitorsModule } from "../monitors/monitors.module";
import { McpController } from "./mcp.controller";
import { McpService } from "./mcp.service";

/**
 * MCP server (Phase1, read-only). Imports the domain modules whose read services the tool catalog calls;
 * ApiTokens (guards), Redis and Audit are @Global. Agent-signing, migrations and existing controllers
 * are untouched — MCP is purely a new read surface over the same team-scoped services.
 */
@Module({
  imports: [ApplicationsModule, ServersModule, ClustersModule, DatabasesModule, BackupsModule, MonitorsModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}

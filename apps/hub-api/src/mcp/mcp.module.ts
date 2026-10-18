import { Module } from "@nestjs/common";
import { ApplicationsModule } from "../applications/applications.module";
import { ServersModule } from "../servers/servers.module";
import { ClustersModule } from "../clusters/clusters.module";
import { DatabasesModule } from "../databases/databases.module";
import { BackupsModule } from "../backups/backups.module";
import { MonitorsModule } from "../monitors/monitors.module";
import { ImporterModule } from "../importer/importer.module";
import { McpController } from "./mcp.controller";
import { McpService } from "./mcp.service";

/**
 * MCP server (read + PAT-scoped mutate). Imports the domain modules whose services the tool catalog calls;
 * ApiTokens (guards), Redis and Audit are @Global. Every tool — read or mutate — goes through the same
 * team-scoped service methods (with their own permission checks + audit) that the REST controllers use, so
 * MCP adds no new authorization path; it is a JSON-RPC surface over the existing capabilities.
 */
@Module({
  imports: [ApplicationsModule, ServersModule, ClustersModule, DatabasesModule, BackupsModule, MonitorsModule, ImporterModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}

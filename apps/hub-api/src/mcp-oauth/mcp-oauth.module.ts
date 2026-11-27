import { Global, Module } from "@nestjs/common";
import { McpOAuthConsentController, McpOAuthEndpointsController, McpOAuthMetadataController } from "./oauth.controller";
import { McpOAuthService } from "./oauth.service";

/** OAuth 2.1 for MCP clients. Global so ApiAuthGuard can resolve its bearer tokens. Prisma, Audit and TeamAccess are global. */
@Global()
@Module({
  controllers: [McpOAuthMetadataController, McpOAuthEndpointsController, McpOAuthConsentController],
  providers: [McpOAuthService],
  exports: [McpOAuthService],
})
export class McpOAuthModule {}

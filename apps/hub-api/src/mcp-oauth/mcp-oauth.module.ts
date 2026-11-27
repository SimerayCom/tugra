import { Global, MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { McpOAuthConsentController, McpOAuthEndpointsController, McpOAuthMetadataController } from "./oauth.controller";
import { McpOAuthService } from "./oauth.service";
import { escapeJsonLineSeparators } from "../mcp/json-line-separators";

/** OAuth 2.1 for MCP clients. Global so ApiAuthGuard can resolve its bearer tokens. Prisma, Audit and TeamAccess are global. */
@Global()
@Module({
  controllers: [McpOAuthMetadataController, McpOAuthEndpointsController, McpOAuthConsentController],
  providers: [McpOAuthService],
  exports: [McpOAuthService],
})
export class McpOAuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // /oauth/register echoes client-supplied metadata: keep raw U+2028/U+2029 off the wire (see mcp/json-line-separators.ts).
    consumer.apply(escapeJsonLineSeparators).forRoutes(McpOAuthEndpointsController);
  }
}

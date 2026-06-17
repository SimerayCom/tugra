import { Global, Module } from "@nestjs/common";
import { ApiTokensController } from "./api-tokens.controller";
import { ApiTokensService } from "./api-tokens.service";
import { ApiAuthGuard } from "./api-auth.guard";

@Global()
@Module({
  controllers: [ApiTokensController],
  providers: [ApiTokensService, ApiAuthGuard],
  exports: [ApiTokensService, ApiAuthGuard],
})
export class ApiTokensModule {}

import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { CryptoModule } from "../crypto/crypto.module";
import { ObjectMigrationsController } from "./object-migrations.controller";
import { ObjectMigrationsService } from "./object-migrations.service";
import { ObjMigrationRunnerService } from "./obj-migration-runner.service";

/**
 * Object (S3/MinIO) migration. A leaf module: it talks to the target agent through the gateway (capability `backup`),
 * keeps its own tables and imports nothing from the importer, so it has no coupling to the import flow.
 */
@Module({
  imports: [AgentGatewayModule, CryptoModule],
  controllers: [ObjectMigrationsController],
  providers: [ObjectMigrationsService, ObjMigrationRunnerService],
  exports: [ObjectMigrationsService],
})
export class ObjectMigrationsModule {}

import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ApplicationsModule } from "../applications/applications.module";
import { AgentFsTransferController } from "./agent-fs-transfer.controller";
import { ContainerFilesController } from "./container-files.controller";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";
import { FileOpLimiter } from "./fs-limiter";
import { FilesStagingSweeper } from "./fs-staging.sweeper";
import { FsTransferService } from "./fs-transfer.service";

/** The file manager's write side (volumes) and the live container filesystem, plus the agent-facing transfer URLs. */
@Module({
  imports: [AgentGatewayModule, ApplicationsModule],
  controllers: [FilesController, ContainerFilesController, AgentFsTransferController],
  providers: [
    FilesService,
    FsTransferService,
    FilesStagingSweeper,
    // Plain constructor args (tunable in tests), so build it explicitly rather than through DI.
    { provide: FileOpLimiter, useFactory: () => new FileOpLimiter() },
  ],
})
export class FilesModule {}

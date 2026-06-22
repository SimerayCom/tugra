import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { GitSourcesController } from "./git-sources.controller";
import { GitSourcesService } from "./git-sources.service";

@Module({
  imports: [CryptoModule],
  controllers: [GitSourcesController],
  providers: [GitSourcesService],
  exports: [GitSourcesService],
})
export class GitSourcesModule {}

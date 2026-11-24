import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { GitSourcesController } from "./git-sources.controller";
import { GitSourcesService } from "./git-sources.service";
import { GithubManifestService } from "./github-manifest.service";

@Module({
  imports: [CryptoModule],
  controllers: [GitSourcesController],
  providers: [GitSourcesService, GithubManifestService],
  exports: [GitSourcesService],
})
export class GitSourcesModule {}

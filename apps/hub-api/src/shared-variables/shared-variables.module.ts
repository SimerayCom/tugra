import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { SharedVariablesController } from "./shared-variables.controller";
import { SharedVariablesService } from "./shared-variables.service";

@Module({
  imports: [CryptoModule],
  controllers: [SharedVariablesController],
  providers: [SharedVariablesService],
  exports: [SharedVariablesService],
})
export class SharedVariablesModule {}

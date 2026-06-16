import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { DestinationsController } from "./destinations.controller";
import { DestinationsService } from "./destinations.service";

@Module({
  imports: [CryptoModule],
  controllers: [DestinationsController],
  providers: [DestinationsService],
  exports: [DestinationsService],
})
export class DestinationsModule {}

import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { CloudModule } from "../cloud/cloud.module";
import { CostsController } from "./costs.controller";
import { CostsService } from "./costs.service";
import { CostsAdviceService } from "./costs-advice.service";
import { RescaleService } from "./rescale.service";

// PrismaService, TeamAccessService and AuditService come from @Global modules.
@Module({
  imports: [CryptoModule, CloudModule],
  controllers: [CostsController],
  providers: [CostsService, CostsAdviceService, RescaleService],
})
export class CostsModule {}

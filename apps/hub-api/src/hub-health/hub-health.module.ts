import { Module } from "@nestjs/common";
import { HubHealthController } from "./hub-health.controller";
import { HubHealthService } from "./hub-health.service";

// PrismaService, RedisService are global.
@Module({ controllers: [HubHealthController], providers: [HubHealthService] })
export class HubHealthModule {}

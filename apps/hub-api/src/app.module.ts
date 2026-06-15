import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { validateEnv } from "./config/env";
import { HealthController } from "./health/health.controller";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { AuditModule } from "./audit/audit.module";
import { TeamAccessModule } from "./common/team-access.module";
import { AuthModule } from "./auth/auth.module";
import { ServersModule } from "./servers/servers.module";
import { AgentGatewayModule } from "./agent-gateway/agent-gateway.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { MonitorsModule } from "./monitors/monitors.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 120 }]),
    PrismaModule,
    RedisModule,
    AuditModule,
    TeamAccessModule,
    AuthModule,
    ServersModule,
    AgentGatewayModule,
    NotificationsModule,
    MonitorsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}

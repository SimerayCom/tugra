import { ConfigService } from "@nestjs/config";
import { MonitorSchedulerService } from "./scheduler.service";
import { PrismaService } from "../prisma/prisma.service";
import { MonitorRunnerService } from "./runner.service";

/**
 * Regression for the BullMQ Redis-connection gap: the scheduler must build its connection from the FULL
 * REDIS_URL (auth, TLS, db-index), not just host+port — otherwise every monitor job fails against an
 * authenticated/TLS/db-indexed Redis. The scheduler delegates to redisConnectionOptions; this proves the wiring.
 */
describe("MonitorSchedulerService.connection", () => {
  const build = (redisUrl: string) => {
    const config = { get: (k: string) => (k === "REDIS_URL" ? redisUrl : undefined) } as unknown as ConfigService;
    const svc = new MonitorSchedulerService(config, {} as PrismaService, {} as MonitorRunnerService);
    return (svc as unknown as { connection: () => Record<string, unknown> }).connection();
  };

  it("carries password, db-index and TLS from an authenticated rediss:// URL", () => {
    const c = build("rediss://:s3cret@redis.example:6380/3");
    expect(c).toMatchObject({ host: "redis.example", port: 6380, password: "s3cret", db: 3 });
    expect(c.tls).toBeDefined();
  });

  it("leaves the default in-compose URL unauthenticated on db 0", () => {
    const c = build("redis://redis:6379");
    expect(c).toMatchObject({ host: "redis", port: 6379, db: 0, maxRetriesPerRequest: null });
    expect(c.password).toBeUndefined();
    expect(c.tls).toBeUndefined();
  });
});

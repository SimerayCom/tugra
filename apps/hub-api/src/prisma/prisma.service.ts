import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { hubDatabaseUrl } from "./database-url";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // The RAM profile's pool size (HUB_DB_CONNECTION_LIMIT / HUB_DB_POOL_TIMEOUT) is added to a copy of DATABASE_URL here only;
    // without those variables (or without DATABASE_URL, as in unit tests) the client reads DATABASE_URL exactly as before.
    const url = hubDatabaseUrl();
    super(url ? { datasourceUrl: url } : undefined);
  }
  private readonly beforeDisconnect: (() => Promise<void>)[] = [];

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /**
   * Run `fn` just before the connection closes on shutdown. Nest destroys a dependency's module BEFORE its
   * consumers', so a buffered writer's own onModuleDestroy could find the client already disconnected; this
   * hook guarantees its final flush still has a database. Failures are swallowed (best-effort).
   */
  registerBeforeDisconnect(fn: () => Promise<void>): void {
    this.beforeDisconnect.push(fn);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.beforeDisconnect.map((fn) => fn().catch(() => undefined)));
    await this.$disconnect();
  }
}

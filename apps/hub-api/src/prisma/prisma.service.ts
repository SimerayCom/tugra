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

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../../../../prisma/prisma.service";
import { CryptoService } from "../../../../crypto/crypto.service";
import { dbContainerName, type DbCredentials } from "../../../../databases/database-script";
import type { RunSnapshot } from "../../../core/run-contract";
import { SOURCE_HOST_PORT, type DbDataItem, type DbStats, type DbStatsPort, type SourceHostPort } from "../data-contract";
import { buildDbStatsScript, statsFromOutput, statsKindOf } from "../verify/db-stats";

const STATS_TIMEOUT_MS = 10 * 60_000;
const GiB = 1024 ** 3;

/**
 * The statement's budget: ten minutes, plus three per GiB of the database (an exact count over a table of hundreds of millions of rows
 * is minutes, not seconds), up to three hours. The size is what the migrator measured; an unmeasured database keeps the plain budget.
 */
export function statsTimeoutMs(db: Pick<DbDataItem, "measure">): number {
  const bytes = db.measure?.state === "measured" ? db.measure.dbBytes : 0;
  return Math.min(Math.max(STATS_TIMEOUT_MS, STATS_TIMEOUT_MS + Math.ceil(bytes / GiB) * 3 * 60_000), 3 * 3600_000);
}

/**
 * Measures a TARGET database for DB logical parity: the hub builds the read-only statement, the target agent runs it
 * inside the database container (capability `database`), the hub parses the answer. Credentials are decrypted in memory
 * for one call; nothing is stored or returned but counts. Every failure is a fixed reason: it is reported as an
 * unmeasured database, never as an empty (passing) one.
 */
@Injectable()
export class TargetDbStats implements DbStatsPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    @Inject(SOURCE_HOST_PORT) private readonly host: SourceHostPort,
  ) {}

  async measureTarget(_run: RunSnapshot, db: DbDataItem, mode: "exact" | "estimate"): Promise<DbStats> {
    const fail = (reason: string): DbStats => ({ itemRef: db.itemRef, engine: db.engine, kind: statsKindOf(db.engine) ?? "tables", mode, state: "failed", reason, tableCount: 0, truncated: false, tables: [] });
    if (!statsKindOf(db.engine)) return { ...fail("no-verify"), state: "skipped" };
    if (!db.dbId) return fail("db-missing");
    const row = await this.prisma.database.findUnique({ where: { id: db.dbId }, select: { id: true, serverId: true, engine: true, credentials: true } });
    if (!row) return fail("db-missing");
    let script: string;
    try {
      const creds = JSON.parse(this.crypto.decrypt(row.credentials)) as DbCredentials;
      script = buildDbStatsScript(row.engine, dbContainerName({ id: row.id }), { username: creds.username, password: creds.password, database: creds.database }, mode);
    } catch {
      return fail("invalid-name");
    }
    try {
      const res = await this.host.run(row.serverId, script, "database", statsTimeoutMs(db));
      return statsFromOutput({ itemRef: db.itemRef, engine: row.engine, mode, output: res.output, exitCode: res.exitCode });
    } catch {
      return fail("verify-exec");
    }
  }
}

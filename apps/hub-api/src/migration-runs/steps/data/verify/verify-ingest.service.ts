import { BadRequestException, ConflictException, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../../prisma/prisma.service";
import { TeamAccessService } from "../../../../common/team-access.service";
import type { MigrationTokenContext } from "../../../../importer/migration-token.service";
import { isTerminalRunStatus, type RunStatus } from "../../../core/run-contract";
import { CHECK_STORE, SOURCE_STATS_CHECK, type CheckStore, type DbStats } from "../data-contract";
import { VerifyBodySchema, type VerifyItem } from "./verify-ingest.dto";

/** A reported item as the VERIFY step reads it back (`DbStats` of the SOURCE side). */
export function statsFromReport(i: VerifyItem): DbStats {
  return {
    itemRef: i.itemRef,
    engine: i.engine,
    kind: i.kind,
    mode: i.mode,
    state: i.state,
    reason: i.reason ?? null,
    tableCount: i.tableCount,
    truncated: i.truncated === true,
    tables: i.tables.map((t) => ({ name: t.name, rows: t.rows, estimated: t.estimated === true, expires: t.expires ?? 0 })),
  };
}

/**
 * Receives the source-side logical-parity measurements from the migrator and stores them as `migrator-reported` evidence
 * on the guided run that owns the op. The destination of every row is hub-derived: the run comes from the TOKEN's op, and
 * an itemRef that is not one of that op's DONE database tasks is dropped (a spoofed ref can never create evidence).
 * A migration run that is not a guided run (the manual flow) simply has nowhere to store the numbers: answered
 * `stored: 0`, never an error, so `--verify` stays harmless there.
 */
@Injectable()
export class VerifyIngestService {
  private readonly logger = new Logger(VerifyIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    @Inject(CHECK_STORE) private readonly checks: CheckStore,
  ) {}

  async ingest(op: MigrationTokenContext, raw: unknown): Promise<{ stored: number; ignored: number }> {
    const parsed = VerifyBodySchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("invalid verify report");
    const run = await this.prisma.migrationRun.findUnique({ where: { opId: op.opId }, select: { id: true, actorId: true, status: true, targetServerId: true } });
    if (!run || isTerminalRunStatus(run.status as RunStatus)) return { stored: 0, ignored: parsed.data.items.length };
    if (run.actorId !== op.actorId) throw new ConflictException("not your operation");
    const server = await this.prisma.server.findUnique({ where: { id: run.targetServerId }, select: { teamId: true } });
    if (!server) throw new ConflictException("target server not found");
    await this.access.requirePermission(op.actorId, server.teamId, "apps:config"); // re-authorized like every ingest route

    const dbs = await this.prisma.bulkTask.findMany({ where: { opId: op.opId, kind: "database", status: "DONE" }, select: { itemRef: true } });
    const valid = new Set(dbs.map((d) => d.itemRef).filter((x): x is string => !!x));
    let stored = 0;
    let ignored = 0;
    for (const item of parsed.data.items) {
      if (!valid.has(item.itemRef)) {
        ignored++;
        continue;
      }
      await this.checks.upsert({
        runId: run.id,
        stepKey: "VERIFY",
        checkId: SOURCE_STATS_CHECK,
        subject: item.itemRef,
        // a raw measurement is not a verdict: VERIFY compares it with the target and writes the verdict row
        status: "unknown",
        evidenceKind: "migrator-reported",
        evidence: statsFromReport(item) as unknown as Record<string, unknown>,
      });
      stored++;
    }
    if (ignored) this.logger.warn(`run ${run.id}: ${ignored} verify item(s) ignored (not a DONE database of the op)`);
    return { stored, ignored };
  }
}

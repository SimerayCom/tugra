import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../../../prisma/prisma.service";
import { HOST_REPORT_KINDS, type HostReport, type HostReportKind, type HostReportPort } from "./inventory-contract";

type Row = { id: string; runId: string; stepKey: string; sourceServerRef: string; kind: string; state: string; payload: Prisma.JsonValue | null; reportedAt: Date };

const toReport = (r: Row): HostReport => ({
  id: r.id,
  runId: r.runId,
  stepKey: r.stepKey,
  sourceServerRef: r.sourceServerRef,
  kind: (HOST_REPORT_KINDS as readonly string[]).includes(r.kind) ? (r.kind as HostReportKind) : "loop",
  state: r.state,
  payload: r.payload && typeof r.payload === "object" && !Array.isArray(r.payload) ? (r.payload as Record<string, unknown>) : null,
  reportedAt: r.reportedAt,
});

/** `MigrationRunHostReport` persistence: the latest report per (run, step, host, kind). */
@Injectable()
export class PrismaHostReportStore implements HostReportPort {
  constructor(private readonly prisma: PrismaService) {}

  async list(runId: string, kind?: HostReportKind): Promise<HostReport[]> {
    const rows = await this.prisma.migrationRunHostReport.findMany({ where: { runId, ...(kind ? { kind } : {}) }, orderBy: [{ reportedAt: "desc" }, { id: "asc" }], take: 2000 });
    return rows.map(toReport);
  }

  async get(runId: string, id: string): Promise<HostReport | null> {
    const row = await this.prisma.migrationRunHostReport.findUnique({ where: { id } });
    return row && row.runId === runId ? toReport(row) : null;
  }

  async put(row: Parameters<HostReportPort["put"]>[0]): Promise<HostReport> {
    const payload = (row.payload ?? undefined) as Prisma.InputJsonValue | undefined;
    const saved = await this.prisma.migrationRunHostReport.upsert({
      where: { runId_stepKey_sourceServerRef_kind: { runId: row.runId, stepKey: row.stepKey, sourceServerRef: row.sourceServerRef, kind: row.kind } },
      create: { runId: row.runId, stepKey: row.stepKey, sourceServerRef: row.sourceServerRef, kind: row.kind, state: row.state, payload },
      update: { state: row.state, payload: payload ?? ({} as Prisma.InputJsonValue), reportedAt: new Date() },
    });
    return toReport(saved);
  }
}

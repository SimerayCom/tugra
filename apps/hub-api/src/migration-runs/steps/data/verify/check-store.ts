import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../../../prisma/prisma.service";
import { CHECK_EVIDENCE_MAX_BYTES, RAW_EVIDENCE_MAX_BYTES, SOURCE_STATS_CHECK, type CheckStore, type RunCheckRow } from "../data-contract";

/** The cap that applies to a check id's evidence. */
export const evidenceCapFor = (checkId: string): number => (checkId === SOURCE_STATS_CHECK ? RAW_EVIDENCE_MAX_BYTES : CHECK_EVIDENCE_MAX_BYTES);

/**
 * Evidence is secret-free by construction (counts, names, ids, codes) and bounded: an oversize value is replaced by a
 * marker rather than failing the verification it documents or filling the table.
 */
export function boundEvidence(checkId: string, evidence: Record<string, unknown> | null): Record<string, unknown> | null {
  if (evidence === null) return null;
  let json: string;
  try {
    json = JSON.stringify(evidence);
  } catch {
    return { truncated: true, reason: "unserializable" };
  }
  const bytes = Buffer.byteLength(json, "utf8");
  return bytes <= evidenceCapFor(checkId) ? evidence : { truncated: true, bytes };
}

/** `MigrationRunCheck` on Postgres. Keyed by (run, step, check, subject): a re-run of a check replaces its row. */
@Injectable()
export class PrismaCheckStore implements CheckStore {
  constructor(private readonly prisma: PrismaService) {}

  async list(runId: string, stepKey: string): Promise<RunCheckRow[]> {
    const rows = await this.prisma.migrationRunCheck.findMany({ where: { runId, stepKey }, orderBy: [{ checkId: "asc" }, { subject: "asc" }] });
    return rows.map((r) => ({
      runId: r.runId,
      stepKey: r.stepKey,
      checkId: r.checkId,
      subject: r.subject,
      status: r.status as RunCheckRow["status"],
      evidenceKind: r.evidenceKind as RunCheckRow["evidenceKind"],
      evidence: r.evidence && typeof r.evidence === "object" && !Array.isArray(r.evidence) ? (r.evidence as Record<string, unknown>) : null,
      at: r.at,
    }));
  }

  async upsert(row: Omit<RunCheckRow, "at"> & { at?: Date }): Promise<void> {
    const evidence = boundEvidence(row.checkId, row.evidence) as Prisma.InputJsonValue | null;
    const data = { status: row.status, evidenceKind: row.evidenceKind, evidence: evidence ?? undefined, at: row.at ?? new Date() };
    await this.prisma.migrationRunCheck.upsert({
      where: { runId_stepKey_checkId_subject: { runId: row.runId, stepKey: row.stepKey, checkId: row.checkId, subject: row.subject } },
      create: { runId: row.runId, stepKey: row.stepKey, checkId: row.checkId, subject: row.subject, ...data },
      update: data,
    });
  }
}

/** In-memory store for specs (same semantics, same evidence bound). */
export class MemoryCheckStore implements CheckStore {
  readonly rows = new Map<string, RunCheckRow>();

  async list(runId: string, stepKey: string): Promise<RunCheckRow[]> {
    return [...this.rows.values()].filter((r) => r.runId === runId && r.stepKey === stepKey).sort((a, b) => (a.checkId + a.subject < b.checkId + b.subject ? -1 : 1));
  }

  async upsert(row: Omit<RunCheckRow, "at"> & { at?: Date }): Promise<void> {
    this.rows.set([row.runId, row.stepKey, row.checkId, row.subject].join("\u0000"), { ...row, evidence: boundEvidence(row.checkId, row.evidence), at: row.at ?? new Date() });
  }
}

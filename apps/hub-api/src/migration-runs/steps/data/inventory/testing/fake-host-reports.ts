import { randomUUID } from "node:crypto";
import type { HostReport, HostReportKind, HostReportPort } from "../inventory-contract";

/** In-memory {@link HostReportPort} for the handler specs. */
export class FakeHostReports implements HostReportPort {
  rows: HostReport[] = [];

  async list(runId: string, kind?: HostReportKind): Promise<HostReport[]> {
    return this.rows.filter((r) => r.runId === runId && (!kind || r.kind === kind));
  }

  async get(runId: string, id: string): Promise<HostReport | null> {
    return this.rows.find((r) => r.runId === runId && r.id === id) ?? null;
  }

  async put(row: Parameters<HostReportPort["put"]>[0]): Promise<HostReport> {
    const i = this.rows.findIndex((r) => r.runId === row.runId && r.stepKey === row.stepKey && r.sourceServerRef === row.sourceServerRef && r.kind === row.kind);
    const saved: HostReport = { id: i >= 0 ? this.rows[i].id : randomUUID(), ...row, reportedAt: new Date("2026-11-20T09:59:00.000Z") };
    if (i >= 0) this.rows[i] = saved;
    else this.rows.push(saved);
    return saved;
  }

  /** Convenience for specs. */
  set(runId: string, r: Omit<Parameters<HostReportPort["put"]>[0], "runId">): void {
    void this.put({ runId, ...r });
  }
}

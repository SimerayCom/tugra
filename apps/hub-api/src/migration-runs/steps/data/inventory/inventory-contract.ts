/**
 * The host-report port: where the per-host reports of the `coolify-host-loop` runner and of the host inventory live (the
 * `MigrationRunHostReport` table behind it), and the facade-side port that builds the host-loop / inventory commands.
 * Handlers talk to these interfaces only; the Prisma implementations are in `host-report.store.ts` and
 * `host-command.service.ts`, the tests use the in-memory fake in `testing/`.
 */
import type { CommandKind, RunSnapshot, StepKey } from "../../../core/run-contract";

export const HOST_REPORT_PORT = Symbol("MIGRATION_RUN_HOST_REPORT_PORT");

export const HOST_REPORT_KINDS = ["loop", "inventory", "reach", "freeze"] as const;
export type HostReportKind = (typeof HOST_REPORT_KINDS)[number];

/** One stored report: the LATEST of its (run, step, host, kind). `payload` is secret-free and bounded. */
export interface HostReport {
  id: string;
  runId: string;
  /** `DATA_SEED` | `FREEZE` | `DATA_FINAL` | `INVENTORY` for loop/freeze reports, `""` for inventory/reach. */
  stepKey: string;
  sourceServerRef: string;
  kind: HostReportKind;
  state: string;
  payload: Record<string, unknown> | null;
  reportedAt: Date;
}

export interface HostReportPort {
  /** Every report of a run (optionally of one kind), newest first. */
  list(runId: string, kind?: HostReportKind): Promise<HostReport[]>;
  /** One report by id, only when it belongs to the run. */
  get(runId: string, id: string): Promise<HostReport | null>;
  /** Create or replace the report of (run, step, host, kind). */
  put(row: { runId: string; stepKey: string; sourceServerRef: string; kind: HostReportKind; state: string; payload: Record<string, unknown> | null }): Promise<HostReport>;
}

/** Nest token of the facade-side builder of the host-loop and inventory commands (provided by the data steps module). */
export const RUN_HOST_COMMANDS = Symbol("MIGRATION_RUN_HOST_COMMANDS");

export interface HostCommandInput {
  run: RunSnapshot;
  step: StepKey;
  kind: Exclude<CommandKind, "migrator">;
  /** The live migration token (shown once, only inside the returned script). */
  token: string;
  hubBase: string;
  /** The check ids the operator attested on the step (`freeze-containers-unresolved` lifts the stop-list guard of a freeze). */
  attested: readonly string[];
}

export interface RunHostCommandPort {
  /** Build the script of a host-loop / inventory command, or throw a `HostCommandError` with a fixed code. */
  build(input: HostCommandInput): Promise<{ command: string; hosts: string[] }>;
}

export class HostCommandError extends Error {
  constructor(readonly code: "no-hosts" | "step-unsupported" | "unsafe-input" | "kind-unsupported") {
    super(code);
    this.name = "HostCommandError";
  }
}

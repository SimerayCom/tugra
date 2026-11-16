/**
 * The commands an OPERATOR pastes on the source host for a data step (the `operator` source runner). The facade's
 * `POST /migration-runs/:id/steps/:key/command` mints/reissues the migration token (`ImportExecutorService`) and calls
 * {@link runCommandsFor} to turn it into the exact commands of the step, so what the operator runs is byte for byte what the
 * same-host launcher would run (`migratorFlags` is the single source of the flags).
 *
 * The token is in the returned strings by design (shown ONCE, like every migration command); it is never stored here.
 */
import { buildMigrationCommand } from "../../../importer/migration-command";
import type { RunSnapshot, StepKey } from "../../core/run-contract";
import type { DataSnapshot } from "./data-contract";
import { migratorFlags, type MigratorPhase } from "./data-logic";

export interface RunCommands {
  /** The bootstrap with no flags (`--arms databases`, the migrator's default). */
  command: string;
  commands: { dryRun: string; run: string; resume: string };
}

const join = (base: string, flags: readonly string[]): string => (flags.length ? `${base} ${flags.join(" ")}` : base);

/** The phase a step's main command runs. DATA_SEED inspects, or warms the databases once every volume was inspected. */
export function phaseFor(stepKey: StepKey, run: RunSnapshot, snap?: Pick<DataSnapshot, "volumes" | "databases">): MigratorPhase | null {
  if (stepKey === "DATA_FINAL") return "final";
  if (stepKey !== "DATA_SEED") return null;
  const inspected = !snap || snap.volumes.every((v) => v.excluded || v.inventory);
  const warmPending = run.options.warmDbSeed && !!snap?.databases.some((d) => d.plane === "logical" && d.task !== "done");
  return inspected && warmPending ? "warm-db" : "inspect";
}

/** The exact commands for `stepKey`, or null for a step that has no migrator command (only DATA_SEED and DATA_FINAL have). */
export function runCommandsFor(stepKey: StepKey, token: string, hubBase: string, run: RunSnapshot, snap?: Pick<DataSnapshot, "volumes" | "databases">): RunCommands | null {
  const phase = phaseFor(stepKey, run, snap);
  if (!phase) return null;
  const bootstrap = buildMigrationCommand(token, hubBase); // validates the token and the base; `--certs` travels as a flag below
  const main = join(bootstrap, migratorFlags(phase, run, snap));
  return { command: bootstrap, commands: { dryRun: join(bootstrap, migratorFlags("inspect", run, snap)), run: main, resume: main } };
}

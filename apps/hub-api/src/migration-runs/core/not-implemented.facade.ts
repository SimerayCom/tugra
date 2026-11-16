import { Injectable, NotImplementedException } from "@nestjs/common";
import type { MigrationRunsFacade } from "./run-contract";

const NI = () => new NotImplementedException("migration-runs: not implemented yet");

/**
 * The C0 placeholder bound to `MIGRATION_RUNS_FACADE`: every route answers 501 (after auth, scope and body validation,
 * so the request contract is already enforced). Lane A deletes this file and binds the real service in
 * `migration-runs.module.ts`.
 */
@Injectable()
export class NotImplementedMigrationRunsFacade implements MigrationRunsFacade {
  create(): never { throw NI(); }
  list(): never { throw NI(); }
  get(): never { throw NI(); }
  events(): never { throw NI(); }
  start(): never { throw NI(); }
  approve(): never { throw NI(); }
  retry(): never { throw NI(); }
  skip(): never { throw NI(); }
  evidence(): never { throw NI(); }
  attach(): never { throw NI(); }
  command(): never { throw NI(); }
  setInputs(): never { throw NI(); }
  pause(): never { throw NI(); }
  resume(): never { throw NI(); }
  abort(): never { throw NI(); }
  cleanup(): never { throw NI(); }
  reverse(): never { throw NI(); }
  decommission(): never { throw NI(); }
  sourceSession(): never { throw NI(); }
  report(): never { throw NI(); }
  reportMarkdown(): never { throw NI(); }
}

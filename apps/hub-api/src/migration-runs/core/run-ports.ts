/**
 * The small outward ports of the run core (P7 lane A). The engine and the service never touch Prisma, the team access
 * service, the importer or the audit log directly: they go through these two seams, which the production module binds to
 * the real services and `testing/run-world.ts` binds to fakes.
 */
import type { ImportAck, RemoteSourceKind, ServiceChoice } from "../../importer/dto";
import type { ImportMappingDoc } from "../../importer/import-mapping";
import type { RunReport, RunScope } from "./dto";
import type { ScopeFailure } from "./run-scope";
import type { RunMode } from "./run-contract";

/** Nest token of the {@link RunEnvPort}. */
export const RUN_ENV = Symbol("MIGRATION_RUN_ENV");
/** Nest token of the {@link RunSinkPort}. */
export const RUN_SINK = Symbol("MIGRATION_RUN_SINK");
/** Nest token of the {@link RunStore}. */
export const RUN_STORE = Symbol("MIGRATION_RUN_STORE");

/** An import session as the run sees it (never the token). `null` from {@link RunEnvPort.session} = missing or not the actor's. */
export interface RunSessionInfo {
  id: string;
  teamId: string;
  sourceKind: RemoteSourceKind;
  baseUrl: string;
  scopeKey: string;
  /** Lower-case `host[:port]` of `baseUrl`: the typed-confirmation target and what the run stores as `sourceHost`. */
  host: string;
  state: "active" | "expired" | "revoked";
  expiresAt: Date;
}

/** The world the run core reads (teams, servers, sessions): all of it read-only except {@link connectSession}. */
export interface RunEnvPort {
  /** The teams the user belongs to. */
  teamIds(userId: string): Promise<string[]>;
  /** The user's standing on a team: membership plus the two permissions every step of a run needs. */
  standing(userId: string, teamId: string): Promise<{ member: boolean; appsConfig: boolean; databases: boolean }>;
  /** `status` and `capabilities` are what create checks a target by (an agent that is not ONLINE, or has no `deploy` grant, cannot take apps); a port that does not report them is not checked. */
  server(serverId: string): Promise<{ id: string; name: string; teamId: string; status?: string; capabilities?: string[] } | null>;
  servers(ids: readonly string[]): Promise<Map<string, string>>;
  /** The actor's own import session (ownership checked), or null. */
  session(userId: string, sessionId: string): Promise<RunSessionInfo | null>;
  /** Mint a NEW import session on the same source with a re-entered token (the token is never returned). */
  connectSession(userId: string, input: { teamId: string; sourceKind: RemoteSourceKind; baseUrl: string; token: string; scopeLabel?: string }): Promise<{ sessionId: string; expiresAt: Date }>;
  /** An object migration the operator wants to attach to a step. */
  objectMigration(id: string): Promise<{ id: string; teamId: string; createdById: string } | null>;
}

/** What the run reports to the outside world: an audit trail and a (best effort) team notification. */
export interface RunSinkPort {
  /** Append `migration.run.*` to the audit log: ids and codes only. */
  audit(entry: { actor: string; action: string; target: string; meta?: Record<string, unknown> }): Promise<void>;
  /** Fire-and-forget notification of a noteworthy state (`waiting`, `failed`, `ponr-reached`, `completed`, ...). Never throws. */
  notify(teamId: string, event: RunNotification): Promise<void>;
}

export interface RunNotification {
  runId: string;
  kind: "waiting" | "failed" | "ponr-reached" | "completed" | "aborted" | "reversed" | "auth-lost" | "stuck-operator";
  mode: RunMode;
  stepKey: string | null;
  code: string | null;
}

/** Nest token of the {@link RunImportPort}. */
export const RUN_IMPORT = Symbol("MIGRATION_RUN_IMPORT");

/** The three importer facts the run core itself needs (everything step-specific lives in the import steps' own port). */
export interface RunImportPort {
  /** Re-discover + re-plan with the session and return the live `planHash` (read-only: it writes nothing). */
  planHash(userId: string, input: { sessionId: string; sourceKind: RemoteSourceKind; dbDataModes?: Record<string, "volume"> }): Promise<string>;
  /**
   * OPTIONAL: the source's own version string (`4.1.2`), read with the session (never the token). Called best effort at
   * create/promote; a missing method, a throw or a null leave the version unknown for PREFLIGHT to fill.
   */
  sourceVersion?(userId: string, input: { sessionId: string; sourceKind: RemoteSourceKind }): Promise<string | null>;
  /**
   * OPTIONAL: resolve a run's `scope` against the live plan into the importer's own exclusions: the mapping document (`include: false`
   * rows), the service choices (skipped stacks) and the mapping hash the later steps re-check. Read-only. `ok: false` carries the
   * stable code of an unknown server / project / item or an empty scope. A missing method means the port cannot narrow a run.
   */
  scopeApply?(
    userId: string,
    input: {
      sessionId: string;
      sourceKind: RemoteSourceKind;
      planHash: string;
      targetServerId: string;
      environmentId?: string;
      reconcile?: boolean;
      dbDataModes?: Record<string, "volume">;
      acks?: ImportAck[];
      serverMap?: Record<string, string>;
      serviceChoices?: Record<string, ServiceChoice>;
      scope: RunScope;
    },
  ): Promise<{ ok: true; mapping: ImportMappingDoc; mappingHash: string; serviceChoices?: Record<string, ServiceChoice>; kept: number; excluded: number } | { ok: false; code: ScopeFailure }>;
  /** The coverage ledger of an import op for the final report (secret-free; empty when the op is unknown). */
  opItems(userId: string, opId: string): Promise<RunReport["items"]>;
  /**
   * OPTIONAL: how each migrated database's data travelled, its checksum and its row-count check, for the final report
   * (secret-free; empty when the op is unknown or the adapter does not know).
   */
  opDataIntegrity?(userId: string, runId: string, opId: string): Promise<RunReport["dataIntegrity"]>;
  /** Mint (or reissue) the migrator token of the op and return the source-host command(s). Shown once. */
  mintCommand(
    userId: string,
    opId: string,
    hubBase: string,
    opts: { reissue: boolean; certs: boolean },
  ): Promise<{ expiresAt: Date; command: string; commands?: { dryRun: string; run: string; resume: string } }>;
}

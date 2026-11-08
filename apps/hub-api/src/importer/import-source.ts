import type { ForeignEnv, ForeignFleet } from "./foreign-fleet";

/** What transports/data a source adapter offers, so the planner/UI can adapt (e.g. warn that volume data
 *  cannot move without SSH, or that DB passwords need a `read:sensitive` token). */
export interface ImportSourceCapabilities {
  apiRead: boolean; // can enumerate the fleet over an API/CLI
  sshRead: boolean; // has host access for volume/data movement
  dbDataDump: boolean; // can dump database contents from the source
  volumeRead: boolean; // can read app volume data from the source
}

export type ImportSourceKind = "coolify" | "dokploy" | "caprover" | "dokku" | "local-docker" | "compose-file";

export type DumpFormat = "pg_custom" | "sql" | "rdb" | "mongo_archive" | "clickhouse_zip";
/** A handle to a source DB dump stream, for the DB-data mover. */
export interface DumpHandle {
  format: DumpFormat;
  stream: NodeJS.ReadableStream;
  sizeHint?: number;
  close(): Promise<void>;
}
/** A handle to read a source volume's bytes, for the volume mover. */
export interface VolumeHandle {
  tarStream: NodeJS.ReadableStream;
  sizeHint?: number;
  close(): Promise<void>;
}

/** Resolved secrets for one resource, plus the refs that could not be resolved (e.g. a vault reference) so
 *  the caller can fail loud rather than deploy with a missing value. */
export interface FetchedSecrets {
  values: Record<string, string>;
  unresolved: ForeignEnv[];
}

/** A source database's REAL credentials, for the apply-time secret path only (never the discovered fleet, a
 *  task result, the plan, an audit row or a log). Every field is optional: a source that cannot read one
 *  (restricted API key, engine without that concept) simply omits it. */
export interface FetchedDbCredentials {
  user?: string;
  password?: string;
  /** The engine's superuser password when the source keeps it separate from `password` (MySQL/MariaDB). */
  rootPassword?: string;
  database?: string;
}

/**
 * One competitor adapter. Every source (Coolify/Dokploy/CapRover/Dokku + local-docker + a pasted compose
 * file) implements this, so the planner and executor stay source-independent. The adapter is constructed
 * with its credentials/connection already supplied (the importer service owns the encrypted session);
 * `verify()` is called before use. `discover()` returns a SECRET-FREE {@link ForeignFleet}; secret values
 * and bulk data are pulled server-side at apply time via the methods below, keyed by source ref.
 */
export interface ImportSource {
  readonly kind: ImportSourceKind;
  capabilities(): ImportSourceCapabilities;
  verify(): Promise<{ ok: boolean; version?: string; detail?: string }>;
  discover(): Promise<ForeignFleet>;
  /** Re-fetch real secret values for one resource at apply time (never sent to the client). */
  fetchSecrets(ref: string): Promise<FetchedSecrets>;
  /** OPTIONAL secret path: a database's real credentials, re-fetched server-side at apply time and keyed by the
   *  discovered DB's `sourceRef`. `undefined` when unavailable. A source that does not implement it (Coolify,
   *  local-docker) makes the executor mint fresh credentials instead. */
  fetchDbCredentials?(ref: string): Promise<FetchedDbCredentials | undefined>;
  /** OPTIONAL secret path: an app's HTTP basic-auth credentials (username + plaintext password), re-fetched
   *  server-side at apply time and keyed by the app's `sourceRef`. NEVER part of discover()/the fleet. `undefined`
   *  when the app has none. A genuine read error MUST throw (the executor reports it as unmapped rather than
   *  leaving the app silently public). */
  fetchBasicAuthCredentials?(ref: string): Promise<Array<{ user: string; password: string }> | undefined>;
  /** Dump a database's contents (requires capabilities().dbDataDump). */
  dumpDb?(ref: string): Promise<DumpHandle>;
  /** Open a volume's bytes as a tar stream (requires capabilities().volumeRead). */
  openVolume?(ref: string): Promise<VolumeHandle>;
  close(): Promise<void>;
}

import type { ForeignEnv, ForeignFleet, ServiceBundle } from "./foreign-fleet";
import type { Unmapped } from "./reason";
import type { RawSettings, SettingsSection } from "./settings/settings-types";

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
  /** Keys that are not valid env names (Coolify strict mode; absent otherwise). NAMES only. */
  invalidKeys?: string[];
  /** Preview-deployment twin rows that were not imported (Coolify; absent when 0). */
  previewSkipped?: number;
  /** Per-variable flags the source carried alongside the values (key -> flags). Absent for sources with none. */
  flags?: Record<string, { buildTime?: boolean; runtime?: boolean; literal?: boolean; multiline?: boolean }>;
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

/** Secret-capable per-app extras, re-fetched SERVER-SIDE at apply time (same pattern as fetchBasicAuthCredentials).
 *  NEVER part of discover()/the fleet/the plan/logs/task output. In-memory only: source -> setter -> DB.
 *  Field names are `labels`/`dockerfile`, NOT customLabels/inlineDockerfile (those key names are scrubbed by
 *  RedactSecretsInterceptor and the MCP sanitizer; keep them out of anything that could be serialised). */
export interface SourceAppExtras {
  labels?: Array<{ key: string; value: string }>; // source order
  dockerfile?: string; // already decoded
  unmapped: Unmapped[]; // fixed reasons only
}

/** How a source resource was doing when the run looked (P7 health baseline): the enum is the one `SourceBaseline` stores. */
export type SourceHealth = "healthy" | "unhealthy" | "unknown" | "exited";

/** A container restarted this often and not currently healthy is crash-looping, whatever its status string says. */
export const CRASH_LOOP_RESTARTS = 10;

/** Was the resource already failing at the source: unhealthy or exited, or restarting without being healthy? */
export const isDegradedHealth = (health: SourceHealth, restartCount: number | null): boolean =>
  health === "unhealthy" || health === "exited" || (health !== "healthy" && restartCount !== null && restartCount >= CRASH_LOOP_RESTARTS);

/** One resource's health at the source, read-only and secret-free (refs, an enum and a counter). */
export interface SourceHealthRow {
  kind: "app" | "database" | "service";
  /** The resource's source ref (a Coolify uuid): the same ref the plan item uses. */
  ref: string;
  /** The source server the resource runs on, when the source says (the plan's `serverRef`). */
  serverRef?: string;
  health: SourceHealth;
  /** Container restart count at read time; null when the source does not report one. */
  restartCount: number | null;
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
  /** OPTIONAL secret path: a database's custom config file text (Coolify `redis_conf`), re-fetched server-side at apply time and keyed by
   *  the discovered DB's `sourceRef`. `undefined` when it has none or the token cannot read it. A genuine read error MUST throw (the
   *  executor turns it into a fixed note; it never fails the database task). NEVER part of discover()/the fleet: it can hold secrets. */
  fetchDbConfigFile?(ref: string): Promise<string | undefined>;
  /** OPTIONAL secret path: an app's HTTP basic-auth credentials (username + plaintext password), re-fetched
   *  server-side at apply time and keyed by the app's `sourceRef`. NEVER part of discover()/the fleet. `undefined`
   *  when the app has none. A genuine read error MUST throw (the executor reports it as unmapped rather than
   *  leaving the app silently public). */
  fetchBasicAuthCredentials?(ref: string): Promise<Array<{ user: string; password: string }> | undefined>;
  /** OPTIONAL secret path: an app's container labels / inline Dockerfile text, re-fetched server-side at apply time
   *  and keyed by the app's `sourceRef`. A genuine read error MUST throw; the executor records it as unmapped
   *  (fixed reason), never as a task failure. */
  fetchAppExtras?(ref: string): Promise<SourceAppExtras | undefined>;
  /** OPTIONAL secret path: a service's env values + config files, re-fetched server-side at apply/preview time and keyed
   *  by the discovered service's `sourceRef`. `undefined` when the token cannot read them (403/404). Any other error is
   *  re-thrown with a FIXED message. Dokploy/local-docker do not implement it. */
  fetchServiceBundle?(ref: string): Promise<ServiceBundle | undefined>;
  /** OPTIONAL read-only: how every app, database and service is doing at the source right now (status string + restart
   *  counter), keyed by the same refs as the plan. Called by the run's PREFLIGHT to take the health baseline; a source that does
   *  not implement it simply has no baseline. A failure MUST throw (a half-read baseline would be read as "healthy"). */
  healthBaseline?(): Promise<SourceHealthRow[]>;
  /** OPTIONAL read-only: the SETTINGS of the source team (notification channels, shared variables, storages, scheduled tasks, server
   *  cleanup, tags, members), read with the session's token. The result holds secret values (a bot token, a variable value): it is
   *  consumed in memory by the settings import and NEVER serialised (the preview is derived from it by `buildSettingsPlan`). A
   *  section the source cannot answer is `{ ok: false, reason }`, never a guess. A source without it carries no settings. */
  readSettings?(only?: ReadonlySet<SettingsSection>): Promise<RawSettings>;
  /** Dump a database's contents (requires capabilities().dbDataDump). */
  dumpDb?(ref: string): Promise<DumpHandle>;
  /** Open a volume's bytes as a tar stream (requires capabilities().volumeRead). */
  openVolume?(ref: string): Promise<VolumeHandle>;
  close(): Promise<void>;
}

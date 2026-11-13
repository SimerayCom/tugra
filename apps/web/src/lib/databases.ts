import type { DbEngine, DbStatus } from "./types";

/** Transitional states: the resource is on its way to RUNNING (or has never been provisioned). */
export function isDbTransitional(s: DbStatus | string): boolean {
  return s === "NEW" || s === "PROVISIONING" || s === "STARTING";
}

export function dbColor(s: DbStatus | string): string {
  if (s === "RUNNING") return "var(--c-g)";
  if (s === "FAILED") return "var(--c-r)";
  if (s === "STOPPED") return "var(--c-am)";
  if (isDbTransitional(s)) return "var(--c-am)"; // amber; callers add a pulse while transitional
  return "var(--c-tx3)";
}

const LABELS: Record<DbEngine, string> = {
  POSTGRES: "PostgreSQL",
  MYSQL: "MySQL",
  REDIS: "Redis",
  MONGO: "MongoDB",
  MARIADB: "MariaDB",
  KEYDB: "KeyDB",
  DRAGONFLY: "Dragonfly",
  CLICKHOUSE: "ClickHouse",
  LIBSQL: "libSQL",
};

export function engineLabel(engine: DbEngine): string {
  return LABELS[engine];
}

const PORTS: Record<DbEngine, number> = {
  POSTGRES: 5432,
  MYSQL: 3306,
  REDIS: 6379,
  MONGO: 27017,
  MARIADB: 3306,
  KEYDB: 6379,
  DRAGONFLY: 6379,
  CLICKHOUSE: 9000,
  LIBSQL: 8080,
};

export function defaultPort(engine: DbEngine): number {
  return PORTS[engine];
}

/** Curated image versions per engine (first = default). User can still pick "custom". */
const VERSIONS: Record<DbEngine, string[]> = {
  POSTGRES: ["17", "16", "15", "14"],
  MYSQL: ["9", "8.4", "8.0"],
  MARIADB: ["11", "10.11"],
  MONGO: ["8", "7", "6"],
  REDIS: ["7.4", "7.2", "7.0"],
  KEYDB: ["latest"],
  DRAGONFLY: ["latest"],
  CLICKHOUSE: ["24", "latest"],
  LIBSQL: ["latest"],
};

export function engineVersions(engine: DbEngine): string[] {
  return VERSIONS[engine];
}

/** Mirrors the hub's supportsBackup — every engine now has a dump/restore pipeline
 *  (incl. Dragonfly `SAVE RDB`/`DFLY LOAD` and ClickHouse `BACKUP … TO File`/`RESTORE`). */
export function engineSupportsBackup(engine: DbEngine): boolean {
  // libSQL has no dump/restore pipeline (its SQLite file is captured by volume backups) — mirror the hub.
  return engine !== "LIBSQL";
}

/** PITR switch state derived from the two row fields (mirrors the hub's state machine: no stamp = still arming). */
export function pitrState(db: { pitrEnabled: boolean; pitrEnabledAt: string | null }): "OFF" | "ARMING" | "ACTIVE" {
  if (!db.pitrEnabled) return "OFF";
  return db.pitrEnabledAt ? "ACTIVE" : "ARMING";
}

/** Only a Postgres database that supports backups can have PITR at all. */
export function pitrAvailable(db: { engine: DbEngine; backupSupported: boolean }): boolean {
  return db.engine === "POSTGRES" && db.backupSupported;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A Date as the LOCAL `YYYY-MM-DDTHH:mm:ss` string a `<input type="datetime-local" step="1">` holds. */
export function toDatetimeLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** The input's local string back to a Date (null when empty/invalid). The browser parses it in local time. */
export function fromDatetimeLocal(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** How far before the window's upper bound the picker defaults to: the very end is the moment most likely to have
 *  no committed change after it (the hub then fails the restore), so start a little earlier. */
export const PITR_DEFAULT_MARGIN_MS = 60_000;

/** Picker bounds + a sensible default from the recoverable window. The picker has second precision, so `min` is
 *  rounded UP to the next whole second (a floored min would offer an instant just before the real earliest, which
 *  the hub rejects) while `max` is floored (always inside). Null when the window is empty/inverted — the caller
 *  disables the picker and shows the window's reason. */
export function pitrPickerBounds(w: { earliest: string | null; latest: string | null }): { min: string; max: string; initial: string } | null {
  if (!w.earliest || !w.latest) return null;
  const earliest = new Date(w.earliest);
  const latest = new Date(w.latest);
  if (Number.isNaN(earliest.getTime()) || Number.isNaN(latest.getTime()) || latest < earliest) return null;
  const minDate = new Date(Math.ceil(earliest.getTime() / 1000) * 1000);
  const maxDate = new Date(Math.floor(latest.getTime() / 1000) * 1000);
  if (maxDate < minDate) return null; // a sub-second window has no whole-second instant inside it
  const initialDate = new Date(Math.max(minDate.getTime(), maxDate.getTime() - PITR_DEFAULT_MARGIN_MS));
  return { min: toDatetimeLocal(minDate), max: toDatetimeLocal(maxDate), initial: toDatetimeLocal(initialDate) };
}

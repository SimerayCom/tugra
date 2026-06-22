import type { DbEngine, DbStatus } from "./types";

export function dbColor(s: DbStatus): string {
  if (s === "RUNNING") return "var(--c-g)";
  if (s === "FAILED") return "var(--c-r)";
  if (s === "STOPPED") return "var(--c-am)";
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
};

export function engineVersions(engine: DbEngine): string[] {
  return VERSIONS[engine];
}

/** Mirrors the hub's supportsBackup — Dragonfly/ClickHouse backup is not yet implemented. */
export function engineSupportsBackup(engine: DbEngine): boolean {
  return engine !== "DRAGONFLY" && engine !== "CLICKHOUSE";
}

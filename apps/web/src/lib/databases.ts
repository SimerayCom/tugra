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
};

export function engineLabel(engine: DbEngine): string {
  return LABELS[engine];
}

const PORTS: Record<DbEngine, number> = {
  POSTGRES: 5432,
  MYSQL: 3306,
  REDIS: 6379,
  MONGO: 27017,
};

export function defaultPort(engine: DbEngine): number {
  return PORTS[engine];
}

import type { Database } from "./types";

/**
 * Databases a backup from `source` can be restored INTO: same engine, same team,
 * not the source itself. (The backend additionally enforces the S3/cross-server
 * rule — a LOCAL backup can't cross machines.)
 */
export function compatibleRestoreTargets(databases: Database[], source: Database): Database[] {
  return databases.filter((d) => d.id !== source.id && d.engine === source.engine && d.teamId === source.teamId);
}

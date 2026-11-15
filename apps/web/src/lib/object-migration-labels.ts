import type { ObjectMigrationStatus, ObjectMigrationWarning } from "./types";

/** Literal keys (so static key-usage checks keep working). */
const STATUS_KEY: Record<ObjectMigrationStatus, string> = {
  DRAFT: "objectMigration.status.DRAFT",
  PREFLIGHTED: "objectMigration.status.PREFLIGHTED",
  SEEDING: "objectMigration.status.SEEDING",
  SEEDED: "objectMigration.status.SEEDED",
  FINALIZING: "objectMigration.status.FINALIZING",
  FINAL: "objectMigration.status.FINAL",
  VERIFYING: "objectMigration.status.VERIFYING",
  DONE: "objectMigration.status.DONE",
  FAILED: "objectMigration.status.FAILED",
};
export const statusLabelKey = (s: ObjectMigrationStatus): string => STATUS_KEY[s] ?? STATUS_KEY.DRAFT;

const WARN_KEY: Record<string, string> = {
  no_agent_image: "objectMigration.warn.no_agent_image",
  probe_incomplete: "objectMigration.warn.probe_incomplete",
  too_many_buckets: "objectMigration.warn.too_many_buckets",
  no_buckets: "objectMigration.warn.no_buckets",
  size_unknown: "objectMigration.warn.size_unknown",
  versions_not_carried: "objectMigration.warn.versions_not_carried",
  dst_not_empty: "objectMigration.warn.dst_not_empty",
  src_unreachable: "objectMigration.preflight.srcUnreachable",
  dst_unreachable: "objectMigration.preflight.dstUnreachable",
  no_mc: "objectMigration.preflight.noMc",
  dst_space_low: "objectMigration.preflight.noSpace",
};

/** The translated text of a fixed-code warning (an unknown code falls back to its bare code, never to server text). */
export function warningText(t: (key: string, vars?: Record<string, string | number>) => string, w: ObjectMigrationWarning): string {
  const key = WARN_KEY[w.code];
  return key ? t(key, { bucket: w.bucket ?? "" }) : w.code;
}

import type { PrismaService } from "../../prisma/prisma.service";
import { evaluateDbGates, type GateId, type GateResult } from "./vx-gates";
import type { VxInventoryItem } from "./vx.dto";
import { VX_RESTORE_BY_PREFIX } from "./vx-dump";
import { pgDataLayout, pgMajorOfDb } from "../../databases/database-script";

/** The slice of a resolved destination the gates need. */
export interface DbGateCtx {
  resourceId: string;
  credentialsCarried?: boolean;
}

/**
 * Evaluate the physical-copy gates of a Postgres data volume against the LIVE destination (record version/image/status,
 * restore and backup rows) and the migrator's stored inventory. Shared by the dry-run view, begin, every part and finish
 * (the destination can change under a long copy), and the apply.
 */
export async function dbGates(
  prisma: Pick<PrismaService, "database" | "restore" | "backup">,
  ctx: DbGateCtx,
  inventory: VxInventoryItem | undefined,
): Promise<GateResult[]> {
  const db = await prisma.database.findUnique({ where: { id: ctx.resourceId }, select: { version: true, image: true, status: true } });
  if (!db) {
    return [{ id: "state", status: "fail", text: "destination no longer exists" }];
  }
  const [restores, backups] = await Promise.all([prisma.restore.count({ where: { databaseId: ctx.resourceId } }), prisma.backup.count({ where: { databaseId: ctx.resourceId } })]);
  const gates = evaluateDbGates({ credentialsCarried: ctx.credentialsCarried, record: { version: db.version, image: db.image, status: db.status, restores, backups }, inventory });
  // A PostgreSQL 18+ destination keeps its cluster one level below the volume root (and Tugra mounts the volume at its parent), so a data
  // directory copied to the volume root would never be found: a layout gate that would pass is turned into a failure (a failing one keeps its own reason).
  const major = pgMajorOfDb(db.version, db.image);
  if (major !== null && major >= 18) return gates.map((g): GateResult => (g.id === "layout" && g.status === "pass" ? { id: "layout", status: "fail", text: PHYSICAL_DEST_PG18_TEXT } : g));
  return gates;
}

/** The first gate (optionally limited to `only`) that is not a pass; null when they all pass. */
export function firstGate(gates: GateResult[], only?: GateId[]): GateResult | null {
  return gates.find((g) => (!only || only.includes(g.id)) && g.status !== "pass") ?? null;
}

/**
 * The gate of a STREAMED DUMP's destination database (a dump restores through the engine's client, so no data-directory gate
 * applies): it must hold nothing that did not come from this migration - no backup, no restore by anyone else - and be either
 * never started (a first claim) or started by this lane's own restore (a retry after a failed apply, which Postgres rolled back and
 * the MySQL family re-runs idempotently). Shared by the transfer's every call and by the apply itself.
 */
export async function dumpDestGate(prisma: Pick<PrismaService, "database" | "restore" | "backup">, resourceId: string): Promise<{ open: true } | { open: false; reason: "gone" | "dirty" }> {
  const db = await prisma.database.findUnique({ where: { id: resourceId }, select: { status: true } });
  if (!db) return { open: false, reason: "gone" };
  const [backups, foreign, ours] = await Promise.all([
    prisma.backup.count({ where: { databaseId: resourceId } }),
    prisma.restore.count({ where: { databaseId: resourceId, NOT: { createdBy: { startsWith: VX_RESTORE_BY_PREFIX } } } }),
    prisma.restore.count({ where: { databaseId: resourceId, createdBy: { startsWith: VX_RESTORE_BY_PREFIX } } }),
  ]);
  if (backups > 0 || foreign > 0 || (db.status !== "NEW" && ours === 0)) return { open: false, reason: "dirty" };
  return { open: true };
}

/** The reason a streamed dump is refused for a PostgreSQL 18+ destination that cannot persist it (a 409 / failure text; the migrator shows it as is). */
export const DUMP_DEST_PG_LAYOUT_TEXT =
  "the destination is a PostgreSQL 18 or newer database that was started before Tugra mounted its data volume where that version keeps its cluster, so a restored database would sit in an anonymous volume and be lost when the container is recreated: create a new database for it";

/** Why a PHYSICAL copy is never offered into a PostgreSQL 18+ destination: its cluster sits one directory level below the volume root. */
export const PHYSICAL_DEST_PG18_TEXT =
  "the destination is PostgreSQL 18 or newer, whose cluster lives under the volume's <major>/docker directory, so a physical copy of a data directory is not supported; use the logical dump";

/**
 * Can the destination database keep what a streamed dump restores into it? A database that Tugra provisioned with the persistent
 * layout (every new PostgreSQL 18+ database: the volume is mounted at /var/lib/postgresql where that major keeps PGDATA) can, like
 * any pre-18 one. Refused only for a PostgreSQL 18+ row that was already started under the old mount: its cluster sits in an
 * anonymous volume, so pg_restore would succeed and the run would read DONE over data that is not persisted. A never-started row
 * (status NEW) is given the persistent layout when it is provisioned. Checked up front (before the first byte moves) and again before the restore.
 */
export async function dumpDestLayout(prisma: Pick<PrismaService, "database">, resourceId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const db = await prisma.database.findUnique({ where: { id: resourceId }, select: { engine: true, version: true, image: true, status: true, pgParentMount: true } });
  if (!db) return { ok: true }; // `dumpDestGate` reports a missing destination
  if (db.engine !== "POSTGRES") return { ok: true };
  if (pgDataLayout(db) === "legacy-anon" && db.status !== "NEW") return { ok: false, reason: DUMP_DEST_PG_LAYOUT_TEXT };
  return { ok: true };
}

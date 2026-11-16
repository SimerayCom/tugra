import type { PrismaService } from "../../prisma/prisma.service";
import { evaluateDbGates, type GateId, type GateResult } from "./vx-gates";
import type { VxInventoryItem } from "./vx.dto";
import { VX_RESTORE_BY_PREFIX } from "./vx-dump";
import { pgMajorOf } from "./vx-targets";

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
  return evaluateDbGates({ credentialsCarried: ctx.credentialsCarried, record: { version: db.version, image: db.image, status: db.status, restores, backups }, inventory });
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

/** The reason a streamed dump is refused for a PostgreSQL 18+ destination (a 409 / failure text; the migrator shows it as is). */
export const DUMP_DEST_PG_LAYOUT_TEXT =
  "the destination is PostgreSQL 18 or newer, whose data directory Tugra database volumes cannot persist yet: a restored database would sit outside the named volume and be lost when the container is recreated";

/** The PostgreSQL major of a database record: its version, else the tag of its image (`postgres:18-alpine` -> 18); null when neither says. */
function recordPgMajor(version: string | null | undefined, image: string | null | undefined): number | null {
  const v = pgMajorOf(version);
  if (v) return Number(v);
  const m = /(?:^|\/)postgres:(\d{1,2})(?:[.-]|$)/.exec((image ?? "").trim());
  return m ? Number(m[1]) : null;
}

/**
 * Can the destination database keep what a streamed dump restores into it? Tugra mounts every Postgres volume at the
 * pre-18 data path with no PGDATA, so a PostgreSQL 18+ image keeps its cluster under `/var/lib/postgresql/<major>/docker`, an
 * anonymous volume that is orphaned the day the container is recreated. pg_restore would still succeed and the run would read
 * DONE over data that is not persisted; refused up front (before the first byte moves) and again before the restore.
 */
export async function dumpDestLayout(prisma: Pick<PrismaService, "database">, resourceId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const db = await prisma.database.findUnique({ where: { id: resourceId }, select: { engine: true, version: true, image: true } });
  if (!db) return { ok: true }; // `dumpDestGate` reports a missing destination
  if (db.engine !== "POSTGRES") return { ok: true };
  const major = recordPgMajor(db.version, db.image);
  return major !== null && major >= 18 ? { ok: false, reason: DUMP_DEST_PG_LAYOUT_TEXT } : { ok: true };
}

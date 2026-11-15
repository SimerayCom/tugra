import type { PrismaService } from "../../prisma/prisma.service";
import { evaluateDbGates, type GateId, type GateResult } from "./vx-gates";
import type { VxInventoryItem } from "./vx.dto";

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

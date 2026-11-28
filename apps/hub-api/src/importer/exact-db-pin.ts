/**
 * A database the import created keeps the image its source runs. The source host's inventory (which reports the digest) arrives after the
 * database record exists and before anything starts it, and a restore or a deploy is the first thing to start it: this writes the exact
 * image the run recorded into the record right before that start. Only a database that was never started takes it (`setImage` refuses any
 * other), only a pin of the record's own repository counts, and the owner's "keep the exact image" box (an `exact-off` hint) wins.
 *
 * Best effort by design: a missing hint, a started database or a failed write leaves the record as it is and never fails the restore or
 * the deploy that called it.
 */
import { DbStatus } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { DatabasesService } from "../databases/databases.service";
import { EXACT_IMAGE_KIND, EXACT_OFF_KIND, decodeExact, isExactPinFor } from "./exact-image";

export interface ExactDbPinDeps {
  prisma: Pick<PrismaService, "migrationRun" | "migrationRunHint" | "bulkTask" | "database">;
  databases: Pick<DatabasesService, "setImage">;
}

/** Returns true when the record was changed. */
export async function pinDatabaseBeforeStart(deps: ExactDbPinDeps, actorId: string, opId: string, dbId: string): Promise<boolean> {
  try {
    const run = await deps.prisma.migrationRun.findUnique({ where: { opId }, select: { id: true, promotedFromId: true } });
    if (!run) return false;
    const task = await deps.prisma.bulkTask.findFirst({ where: { opId, resourceId: dbId, kind: "database" }, select: { itemRef: true } });
    if (!task?.itemRef) return false;
    const runIds = [run.id, ...(run.promotedFromId ? [run.promotedFromId] : [])];
    const rows = await deps.prisma.migrationRunHint.findMany({ where: { runId: { in: runIds }, key: task.itemRef, scope: "", kind: { in: [EXACT_IMAGE_KIND, EXACT_OFF_KIND] } }, select: { runId: true, kind: true, value: true } });
    // the run's own hint wins over the dry run it was promoted from
    const ownFirst = (a: { runId: string }, b: { runId: string }): number => (a.runId === run.id ? -1 : 0) - (b.runId === run.id ? -1 : 0);
    if (rows.filter((r) => r.kind === EXACT_OFF_KIND).sort(ownFirst)[0]?.value === "off") return false;
    const hint = rows.filter((r) => r.kind === EXACT_IMAGE_KIND).sort(ownFirst)[0];
    const pin = hint ? decodeExact(hint.value) : null;
    if (!pin) return false;
    const db = await deps.prisma.database.findUnique({ where: { id: dbId }, select: { image: true, status: true } });
    if (!db || db.status !== DbStatus.NEW || !isExactPinFor(db.image, pin.ref)) return false;
    return (await deps.databases.setImage(actorId, dbId, pin.ref)).changed;
  } catch {
    return false;
  }
}

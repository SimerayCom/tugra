/**
 * A database the import created keeps the image its source runs. The source host's inventory (which reports the digest) arrives after the
 * database record exists and before anything starts it, and a restore or a deploy is the first thing to start it: this writes the exact
 * image the run recorded into the record right before that start. Only a database that was never started takes it (`setImage` refuses any
 * other), only a pin of the record's own repository counts, and the owner's "keep the exact image" box (an `exact-off` hint) wins.
 *
 * Never silent: when the database is about to start and the record does NOT end up on the image the source runs (no inventory reached the
 * run yet, the host reported no digest for it, it was started before the pin arrived, the pin is of another repository, or the write
 * failed) the run records a warning event naming the database (`EXACT_UNAPPLIED_CODE`), which the run report and the safety card list.
 * Best effort in effect: the warning is the only thing that can fail the other way, and a failed write of it never fails the restore or
 * the deploy that called it.
 */
import { DbStatus } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { DatabasesService } from "../databases/databases.service";
import { EXACT_IMAGE_KIND, EXACT_OFF_KIND, decodeExactHint, isDigestPinned, isExactPinFor } from "./exact-image";

/** The run event of an item that starts on an image the source does not necessarily run. Params: `kind`, `name`, `itemRef`, `reason`. */
export const EXACT_UNAPPLIED_CODE = "import.exact-image-unapplied";
/** Why the record is not on the image the source runs. */
export const EXACT_UNAPPLIED_REASONS = ["no-inventory", "no-digest", "started", "other-repository", "write-failed", "refused"] as const;
export type ExactUnappliedReason = (typeof EXACT_UNAPPLIED_REASONS)[number];

export interface ExactDbPinDeps {
  prisma: Pick<PrismaService, "migrationRun" | "migrationRunHint" | "migrationRunEvent" | "migrationRunHostReport" | "bulkTask" | "database">;
  databases: Pick<DatabasesService, "setImage">;
}

/** Append the warning to the run's events (once per item and reason). Never throws. */
export async function recordExactUnapplied(prisma: Pick<PrismaService, "migrationRun" | "migrationRunEvent">, runId: string, p: { kind: "app" | "database" | "service"; name: string; itemRef: string; reason: ExactUnappliedReason }, stepKey: string | null = null): Promise<void> {
  try {
    const seen = await prisma.migrationRunEvent.findFirst({ where: { runId, code: EXACT_UNAPPLIED_CODE, AND: [{ params: { path: ["itemRef"], equals: p.itemRef } }, { params: { path: ["reason"], equals: p.reason } }] }, select: { seq: true } });
    if (seen) return;
    const r = await prisma.migrationRun.update({ where: { id: runId }, data: { eventSeq: { increment: 1 } }, select: { eventSeq: true } });
    await prisma.migrationRunEvent.create({ data: { runId, seq: r.eventSeq, stepKey, level: "warn", code: EXACT_UNAPPLIED_CODE, params: { kind: p.kind, name: p.name.slice(0, 300), itemRef: p.itemRef.slice(0, 300), reason: p.reason } } });
  } catch {
    /* the warning is best effort: the restore or the deploy that called goes on */
  }
}

/** Returns true when the record was changed. */
export async function pinDatabaseBeforeStart(deps: ExactDbPinDeps, actorId: string, opId: string, dbId: string): Promise<boolean> {
  let runId: string | null = null;
  let warn: { itemRef: string; name: string; reason: ExactUnappliedReason } | null = null;
  let changed = false;
  try {
    const run = await deps.prisma.migrationRun.findUnique({ where: { opId }, select: { id: true, promotedFromId: true } });
    if (!run) return false;
    runId = run.id;
    const task = await deps.prisma.bulkTask.findFirst({ where: { opId, resourceId: dbId, kind: "database" }, select: { itemRef: true } });
    if (!task?.itemRef) return false;
    const itemRef = task.itemRef;
    const runIds = [run.id, ...(run.promotedFromId ? [run.promotedFromId] : [])];
    const rows = await deps.prisma.migrationRunHint.findMany({ where: { runId: { in: runIds }, key: itemRef, scope: "", kind: { in: [EXACT_IMAGE_KIND, EXACT_OFF_KIND] } }, select: { runId: true, kind: true, value: true } });
    // the run's own hint wins over the dry run it was promoted from
    const ownFirst = (a: { runId: string }, b: { runId: string }): number => (a.runId === run.id ? -1 : 0) - (b.runId === run.id ? -1 : 0);
    if (rows.filter((r) => r.kind === EXACT_OFF_KIND).sort(ownFirst)[0]?.value === "off") return false; // the owner chose the tag the source writes
    const db = await deps.prisma.database.findUnique({ where: { id: dbId }, select: { image: true, status: true, name: true } });
    if (!db) return false;
    const mine = { itemRef, name: db.name };
    const hint = rows.filter((r) => r.kind === EXACT_IMAGE_KIND).sort(ownFirst)[0];
    const pin = hint ? decodeExactHint(hint.value) : null;
    if (!pin) {
      if (!isDigestPinned(db.image)) {
        const reported = await deps.prisma.migrationRunHostReport.count({ where: { runId: { in: runIds }, kind: "inventory", state: "complete" } });
        warn = { ...mine, reason: reported === 0 ? "no-inventory" : "no-digest" };
      }
      return false;
    }
    if (db.image === pin.ref) return false;
    if (db.status !== DbStatus.NEW) warn = { ...mine, reason: "started" };
    else if (!isExactPinFor(db.image, pin.ref)) warn = { ...mine, reason: "other-repository" };
    else {
      try {
        changed = (await deps.databases.setImage(actorId, dbId, pin.ref)).changed;
      } catch {
        warn = { ...mine, reason: "write-failed" };
      }
    }
    return changed;
  } catch {
    return changed;
  } finally {
    if (warn && runId) await recordExactUnapplied(deps.prisma, runId, { kind: "database", ...warn });
  }
}

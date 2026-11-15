/**
 * Purging what a move leaves behind: the stopped original volumes on the SOURCE after a COMPLETED move (the archive,
 * kept for `retainDays`), and the target's leftovers (staging, created volumes, apply rollback snapshots) of a
 * ROLLED_BACK / FAILED move. Plain functions over a narrow set of dependencies so the sweeper, the purge-source endpoint
 * and ApplicationsService.remove() all share one implementation (and one set of guards).
 */
import type { AppMove } from "@prisma/client";
import { APP_MOVE_TERMINAL } from "../common/app-move-guard";
import { MOVE_TIMEOUTS, buildMoveArchivePurgeScript, buildMoveCleanupScript, isValidDockerName, parseMoveVolResults } from "./app-move-scripts";
import { asArray, type StoredVolume } from "./move-types";

/** What the purge needs from the world. PrismaService / AgentWsServer satisfy it structurally. */
export interface ArchiveDeps {
  prisma: {
    appMove: {
      update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
      findFirst(args: Record<string, unknown>): Promise<{ id: string } | null>;
    };
    application: { findUnique(args: { where: { id: string }; select: { serverId: true } }): Promise<{ serverId: string } | null> };
  };
  agentWs: {
    isOnline(serverId: string): boolean;
    sendCommand(serverId: string, script: string, capability: "backup", timeoutMs: number): Promise<{ exitCode: number; output: string }>;
  };
}

export type PurgeOutcome = "purged" | "nothing" | "skipped_live" | "offline" | "partial" | "failed";

/** The source volumes a move transferred (the archive): only APPLIED ones, names re-validated before any use. */
export function archiveVolumeNames(move: Pick<AppMove, "volumes">): string[] {
  return asArray<StoredVolume>(move.volumes)
    .filter((v) => v && v.state === "APPLIED" && isValidDockerName(v.dockerName))
    .map((v) => v.dockerName);
}

/**
 * The target-side leftovers of a move that did not complete: every volume the move may have created and the apply
 * rollback snapshots. Selection is by what the volume can NOT be, not by the `createdOnTarget` flag: that flag is only
 * persisted when the whole prepare script succeeded, so a prepare that died halfway (volume 3 of 5 failed) would leave
 * volumes 1-2 labelled `tugra.move=<id>` but unrecorded. The cleanup script re-checks that label in-script, so a
 * volume this move did not create (a foreign one, or an older move's archive) is only ever reported `skipped`.
 * Excluded: archives of an earlier move that the apply overwrote, and - unless `includeKept` (an explicit purge) - the
 * rollback snapshots flagged `rollbackKept`, which may be the only intact copy of the data an apply wiped.
 */
export function targetLeftovers(move: Pick<AppMove, "id" | "volumes">, opts: { includeKept?: boolean } = {}): { removeVolumes: string[]; removeRollbackFor: string[] } {
  const vols = asArray<StoredVolume>(move.volumes);
  return {
    removeVolumes: vols.filter((v) => v && v.state !== "SKIPPED" && !v.archiveOverwritten && isValidDockerName(v.dockerName)).map((v) => v.dockerName),
    removeRollbackFor: vols.map((v, i) => (v && v.state !== "SKIPPED" && (opts.includeKept || !v.rollbackKept) ? `${move.id}_${i}` : null)).filter((x): x is string => !!x),
  };
}

/** True while an apply rollback snapshot is deliberately kept for the user (see StoredVolume.rollbackKept). */
export function hasKeptSnapshots(move: Pick<AppMove, "volumes">): boolean {
  return asArray<StoredVolume>(move.volumes).some((v) => v && v.state !== "SKIPPED" && v.rollbackKept === true);
}

/**
 * Remove a COMPLETED move's archived source volumes. Guards (each a documented safety):
 *  - the app lives on the source server again (a move back) or another live move uses that server for the app: the data
 *    there is LIVE — nothing is removed; the sweeper stamps the row (`stampWhenLive`), an explicit purge reports it;
 *  - docker itself refuses to remove an in-use volume (the last safety net) — those are "partial" and retried.
 */
export async function purgeMoveSource(deps: ArchiveDeps, move: AppMove, opts: { stampWhenLive: boolean }): Promise<PurgeOutcome> {
  const stamp = (): Promise<unknown> => deps.prisma.appMove.update({ where: { id: move.id }, data: { sourcePurgedAt: new Date() } });
  const names = archiveVolumeNames(move);
  if (names.length === 0) {
    await stamp();
    return "nothing";
  }
  const app = await deps.prisma.application.findUnique({ where: { id: move.appId }, select: { serverId: true } });
  const busy = await deps.prisma.appMove.findFirst({
    where: {
      appId: move.appId,
      id: { not: move.id },
      phase: { notIn: APP_MOVE_TERMINAL },
      OR: [{ sourceServerId: move.sourceServerId }, { targetServerId: move.sourceServerId }],
    },
  });
  // A live move of the same app that uses this server may still roll back: nothing is removed and nothing is stamped, so
  // the next sweep re-evaluates once that move is terminal (COMPLETED -> the app is on the source again and the row is
  // consumed below; ROLLED_BACK -> the app is elsewhere and the archive is purged normally).
  if (busy) return "skipped_live";
  if (app?.serverId === move.sourceServerId) {
    if (opts.stampWhenLive) await stamp(); // a completed move back consumed the archive: never remove, never retry
    return "skipped_live";
  }
  if (!deps.agentWs.isOnline(move.sourceServerId)) return "offline";
  try {
    const r = await deps.agentWs.sendCommand(move.sourceServerId, buildMoveArchivePurgeScript(names), "backup", 5 * 60_000);
    if (r.exitCode !== 0) return "failed";
    const parsed = parseMoveVolResults(r.output, names);
    if (!parsed.complete || parsed.leftover.length) return "partial";
    await stamp();
    return "purged";
  } catch {
    return "failed";
  }
}

/**
 * The data on `move.targetServerId` is the app's LIVE data when the app row points there (a FAILED move can stop after
 * the cutover committed) or another live move of the app uses that server. Same guard purgeMoveSource has.
 */
async function targetIsLive(deps: ArchiveDeps, move: AppMove): Promise<boolean> {
  const app = await deps.prisma.application.findUnique({ where: { id: move.appId }, select: { serverId: true } });
  if (app?.serverId === move.targetServerId) return true;
  const busy = await deps.prisma.appMove.findFirst({
    where: {
      appId: move.appId,
      id: { not: move.id },
      phase: { notIn: APP_MOVE_TERMINAL },
      OR: [{ sourceServerId: move.targetServerId }, { targetServerId: move.targetServerId }],
    },
  });
  return !!busy;
}

/**
 * Retry the target-side cleanup of a ROLLED_BACK / FAILED move; stamps `targetPurgedAt` only when everything is gone.
 * Never touches a target that holds the app's live data (`skipped_live`, nothing sent). `includeKept` (an explicit
 * purge-source only) also removes the apply rollback snapshots that automatic cleanup keeps.
 */
export async function retryTargetCleanup(deps: ArchiveDeps, move: AppMove, opts: { includeKept?: boolean } = {}): Promise<PurgeOutcome> {
  if (await targetIsLive(deps, move)) return "skipped_live";
  if (!deps.agentWs.isOnline(move.targetServerId)) return "offline";
  try {
    const { removeVolumes, removeRollbackFor } = targetLeftovers(move, opts);
    const r = await deps.agentWs.sendCommand(move.targetServerId, buildMoveCleanupScript(move.id, { removeVolumes, removeRollbackFor }), "backup", MOVE_TIMEOUTS.prepare);
    if (r.exitCode !== 0) return "failed";
    const parsed = parseMoveVolResults(r.output, [...removeVolumes, ...removeRollbackFor.map((id) => `tugra_restore_rb_${id}`)]);
    if (!parsed.complete || parsed.leftover.length) return "partial";
    const data: Record<string, unknown> = { targetPurgedAt: new Date() };
    if (opts.includeKept && hasKeptSnapshots(move)) {
      // the user purged them: the flags and their warning are spent
      data.volumes = asArray<StoredVolume>(move.volumes).map((v) => (v && v.rollbackKept ? { ...v, rollbackKept: false } : v));
      data.warnings = asArray<{ code?: string }>(move.warnings).filter((w) => w?.code !== "apply_snapshot_kept");
    }
    await deps.prisma.appMove.update({ where: { id: move.id }, data });
    return "purged";
  } catch {
    return "failed";
  }
}

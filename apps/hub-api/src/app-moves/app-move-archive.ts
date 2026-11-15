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

/** The target-side leftovers of a move that did not complete: volumes IT created (never one that pre-existed or an
 *  overwritten archive) and the apply rollback snapshots of every volume it got to. */
export function targetLeftovers(move: Pick<AppMove, "id" | "volumes">): { removeVolumes: string[]; removeRollbackFor: string[] } {
  const vols = asArray<StoredVolume>(move.volumes);
  return {
    removeVolumes: vols.filter((v) => v && v.state !== "SKIPPED" && v.createdOnTarget && !v.archiveOverwritten && isValidDockerName(v.dockerName)).map((v) => v.dockerName),
    removeRollbackFor: vols.map((v, i) => (v && v.state !== "SKIPPED" ? `${move.id}_${i}` : null)).filter((x): x is string => !!x),
  };
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
  if (app?.serverId === move.sourceServerId || busy) {
    if (opts.stampWhenLive) await stamp(); // consumed by a move back / still in use: never remove, never retry
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

/** Retry the target-side cleanup of a ROLLED_BACK / FAILED move; stamps `targetPurgedAt` only when everything is gone. */
export async function retryTargetCleanup(deps: ArchiveDeps, move: AppMove): Promise<PurgeOutcome> {
  if (!deps.agentWs.isOnline(move.targetServerId)) return "offline";
  try {
    const r = await deps.agentWs.sendCommand(move.targetServerId, buildMoveCleanupScript(move.id, targetLeftovers(move)), "backup", MOVE_TIMEOUTS.prepare);
    if (r.exitCode !== 0) return "failed";
    const { removeVolumes, removeRollbackFor } = targetLeftovers(move);
    const parsed = parseMoveVolResults(r.output, [...removeVolumes, ...removeRollbackFor.map((id) => `tugra_restore_rb_${id}`)]);
    if (!parsed.complete || parsed.leftover.length) return "partial";
    await deps.prisma.appMove.update({ where: { id: move.id }, data: { targetPurgedAt: new Date() } });
    return "purged";
  } catch {
    return "failed";
  }
}

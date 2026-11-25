import { Injectable } from "@nestjs/common";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { PartTransferService } from "../app-moves/part-transfer.service";
import {
  MOVE_TIMEOUTS,
  buildMoveApplyScript,
  buildMoveCleanupScript,
  buildMovePackScript,
  buildMovePartStatScript,
  buildMoveSourcePartDropScript,
  parseMoveApplyOk,
  parseMovePacked,
  parseMovePart,
} from "../app-moves/app-move-scripts";

const GIB = 1024 ** 3;
const PART_BYTES = 256 * 1024 * 1024;
const PART_ATTEMPTS = 3;
const BUSY_WAIT_MS = 2000;
/** The size the timeouts are budgeted for when the volume's own size is not known (a database's extra volumes are small next to its data). */
const TIMEOUT_BYTES = 20 * GIB;

/** Why a volume could not be carried. Fixed words, never the scripts' output. */
export class VolumeCarryError extends Error {
  constructor(readonly reason: "agent_offline" | "pack_failed" | "part_failed" | "transfer_failed" | "apply_failed" | "entry_mismatch") {
    super(reason);
  }
}

export interface CarryInput {
  /** The project move's id (a cuid: it names the staging directory on both hosts, so it can never meet another move's). */
  moveId: string;
  /** Distinct per volume inside the move (0..999). */
  idx: number;
  srcServerId: string;
  dstServerId: string;
  srcVolume: string;
  dstVolume: string;
}

/**
 * Copy one docker volume from one Tugra server to another with the same machinery an app move uses for its volumes: pack on the source
 * (gzip, fixed-size parts, checksums), every part through the hub's memory-only relay with its size and sha256 checked at both ends, apply on
 * the target (verify, then replace the volume's content, with the apply's own rollback, entry count compared). Nothing is staged on the hub.
 *
 * The caller has stopped the database that uses the volume on both sides: the pack reads it read-only, but only a quiet volume gives a
 * matching entry count. The staging directory is removed on both hosts afterwards, whatever happened (best effort).
 */
@Injectable()
export class ProjectMoveVolumeCarryService {
  /** Back-off between busy relay seats; tests set it to 0. */
  busyWaitMs = BUSY_WAIT_MS;

  constructor(
    private readonly agentWs: AgentWsServer,
    private readonly transfers: PartTransferService,
  ) {}

  private sleep(ms: number): Promise<void> {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  private async cmd(serverId: string, script: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
    try {
      return await this.agentWs.sendCommand(serverId, script, "backup", timeoutMs);
    } catch {
      throw new VolumeCarryError("agent_offline");
    }
  }

  async carry(i: CarryInput): Promise<void> {
    // built first: a move id that is not a plain id throws here, before anything is sent anywhere
    const cleanup = buildMoveCleanupScript(i.moveId);
    try {
      await this.run(i);
    } finally {
      // the staging directory only; the volumes this call wrote are the caller's, never removed here
      await Promise.allSettled([this.agentWs.sendCommand(i.srcServerId, cleanup, "backup", MOVE_TIMEOUTS.drop), this.agentWs.sendCommand(i.dstServerId, cleanup, "backup", MOVE_TIMEOUTS.drop)]);
    }
  }

  private async run(i: CarryInput): Promise<void> {
    const packed = await this.cmd(i.srcServerId, buildMovePackScript({ moveId: i.moveId, idx: i.idx, dockerVolume: i.srcVolume, partBytes: PART_BYTES }), MOVE_TIMEOUTS.pack(TIMEOUT_BYTES));
    const pk = packed.exitCode === 0 ? parseMovePacked(packed.output) : null;
    if (!pk) throw new VolumeCarryError("pack_failed");

    for (let p = 0; p < pk.parts; p++) {
      const st = await this.cmd(i.srcServerId, buildMovePartStatScript(i.moveId, i.idx, p), MOVE_TIMEOUTS.stat);
      const info = st.exitCode === 0 ? parseMovePart(st.output) : null;
      if (!info) throw new VolumeCarryError("part_failed");
      await this.part(i, p, info);
      // freed only after both ends succeeded; a failed drop is harmless (the cleanup removes the staging directory)
      await this.agentWs.sendCommand(i.srcServerId, buildMoveSourcePartDropScript(i.moveId, i.idx, p), "backup", MOVE_TIMEOUTS.drop).catch(() => undefined);
    }

    const applied = await this.cmd(i.dstServerId, buildMoveApplyScript({ moveId: i.moveId, idx: i.idx, dockerVolume: i.dstVolume, restoreId: `${i.moveId}_${i.idx}`, expectedEntries: pk.entries }), MOVE_TIMEOUTS.apply(TIMEOUT_BYTES));
    if (applied.exitCode !== 0) throw new VolumeCarryError(applied.exitCode === 68 ? "entry_mismatch" : "apply_failed");
    if (parseMoveApplyOk(applied.output) !== pk.entries) throw new VolumeCarryError("entry_mismatch");
  }

  /** One part through the relay: a busy seat waits and does not count; three real failures end it. */
  private async part(i: CarryInput, part: number, info: { size: number; sha256: string }): Promise<void> {
    let attempt = 0;
    for (;;) {
      const r = await this.transfers.transfer({ moveId: i.moveId, idx: i.idx, part, size: info.size, sha256: info.sha256, srcServerId: i.srcServerId, dstServerId: i.dstServerId });
      if (r.ok) return;
      if (r.busy) {
        await this.sleep(this.busyWaitMs);
        continue;
      }
      attempt += 1;
      if (attempt >= PART_ATTEMPTS) throw new VolumeCarryError("transfer_failed");
    }
  }
}

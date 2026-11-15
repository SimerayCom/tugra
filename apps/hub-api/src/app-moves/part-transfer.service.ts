import { Injectable } from "@nestjs/common";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { MOVE_TIMEOUTS, buildMoveRecvScript, buildMoveSendScript, hasMarker, scrubMoveOutput } from "./app-move-scripts";
import { VolumeRelayService, type RelayRegistration } from "./volume-relay.service";

export interface PartTransferRequest {
  moveId: string;
  idx: number;
  part: number;
  size: number;
  sha256: string;
  srcServerId: string;
  dstServerId: string;
  /** curl --max-time inside each command (seconds); default 14 min. */
  maxTimeSec?: number;
  /** Hard cap for each agent command (ms); default MOVE_TIMEOUTS.transfer. */
  timeoutMs?: number;
}

export interface PartTransferHandle {
  /** Abort the transfer: kills both agent commands (signed command_cancel) and the relay rendezvous. Idempotent. */
  cancel(reason: Error): void;
}

export type PartTransferResult =
  | { ok: true; bytes: number }
  | {
      ok: false;
      /** The hub-wide relay cap is reached: wait and retry (NOT a failure of the part). */
      busy?: boolean;
      sendExit: number | null;
      recvExit: number | null;
      /** Scrubbed, short description for the move's log tail (never a signed path). */
      detail: string;
    };

/**
 * Moves ONE part from the source agent to the target agent through the memory-only relay: mints the claim, runs the
 * receive (target) and the send (source) commands CONCURRENTLY, and succeeds only when BOTH exited 0 with their marker
 * AND the relay confirms the target consumed exactly the signed bytes. A failure on either side cancels the other so a
 * dead peer never leaves its partner waiting out the relay's idle timeout.
 */
@Injectable()
export class PartTransferService {
  constructor(
    private readonly agentWs: AgentWsServer,
    private readonly relay: VolumeRelayService,
  ) {}

  async transfer(req: PartTransferRequest, onHandle?: (h: PartTransferHandle) => void): Promise<PartTransferResult> {
    const reg = this.relay.register({
      moveId: req.moveId,
      volIdx: req.idx,
      part: req.part,
      size: req.size,
      sha256: req.sha256,
      srcServerId: req.srcServerId,
      dstServerId: req.dstServerId,
    });
    if (reg.busy) return { ok: false, busy: true, sendExit: null, recvExit: null, detail: "relay busy" };
    return this.run(reg, req, onHandle);
  }

  private async run(reg: RelayRegistration, req: PartTransferRequest, onHandle?: (h: PartTransferHandle) => void): Promise<PartTransferResult> {
    const timeoutMs = req.timeoutMs ?? MOVE_TIMEOUTS.transfer;
    const sendScript = buildMoveSendScript({ moveId: req.moveId, idx: req.idx, part: req.part, path: reg.srcPath, maxTimeSec: req.maxTimeSec });
    const recvScript = buildMoveRecvScript({ moveId: req.moveId, idx: req.idx, part: req.part, path: reg.dstPath, size: req.size, sha256: req.sha256, maxTimeSec: req.maxTimeSec });
    const reqIds: { src?: string; dst?: string } = {};
    let aborted = false;
    const abort = (reason: Error): void => {
      if (aborted) return;
      aborted = true;
      reg.cancel(reason);
      if (reqIds.src) this.agentWs.cancelCommand(req.srcServerId, reqIds.src);
      if (reqIds.dst) this.agentWs.cancelCommand(req.dstServerId, reqIds.dst);
    };
    onHandle?.({ cancel: abort });

    const launch = (serverId: string, script: string, side: "src" | "dst"): Promise<{ exitCode: number; output: string }> =>
      this.agentWs
        .sendCommand(serverId, script, "backup", timeoutMs, undefined, (reqId) => {
          reqIds[side] = reqId;
          // cancel() may have been called before the command reached the wire
          if (aborted) this.agentWs.cancelCommand(serverId, reqId);
        })
        .then((r) => {
          if (r.exitCode !== 0) abort(new Error(`${side} command exited ${r.exitCode}`));
          return r;
        })
        .catch((e: unknown) => {
          abort(e instanceof Error ? e : new Error(String(e)));
          throw e;
        });

    const recvP = launch(req.dstServerId, recvScript, "dst");
    const sendP = launch(req.srcServerId, sendScript, "src");
    const [send, recv] = await Promise.allSettled([sendP, recvP]);

    const sendExit = send.status === "fulfilled" ? send.value.exitCode : null;
    const recvExit = recv.status === "fulfilled" ? recv.value.exitCode : null;
    const sendOk = send.status === "fulfilled" && send.value.exitCode === 0 && hasMarker(send.value.output, "TUGRA_VX_SEND_OK");
    const recvOk = recv.status === "fulfilled" && recv.value.exitCode === 0 && hasMarker(recv.value.output, "TUGRA_VX_RECV_OK");
    if (sendOk && recvOk) {
      try {
        const done = await reg.done; // the relay counted exactly the signed bytes and the hub-side sha matched
        if (done.bytes === req.size && done.sha256 === req.sha256) return { ok: true, bytes: done.bytes };
        return { ok: false, sendExit, recvExit, detail: "relay counters differ from the signed part" };
      } catch (e) {
        return { ok: false, sendExit, recvExit, detail: scrubMoveOutput(e instanceof Error ? e.message : String(e)) };
      }
    }
    reg.cancel(new Error("part transfer failed"));
    const why = (side: string, r: PromiseSettledResult<{ exitCode: number; output: string }>): string =>
      r.status === "rejected"
        ? `${side}: ${scrubMoveOutput(r.reason instanceof Error ? r.reason.message : String(r.reason))}`
        : r.value.exitCode !== 0
          ? `${side} exit ${r.value.exitCode}: ${scrubMoveOutput(r.value.output).trim().split("\n").slice(-2).join(" | ")}`
          : `${side}: missing completion marker`;
    const parts = [recvOk ? null : why("target", recv), sendOk ? null : why("source", send)].filter((x): x is string => !!x);
    return { ok: false, sendExit, recvExit, detail: parts.join("; ").slice(0, 600) };
  }
}

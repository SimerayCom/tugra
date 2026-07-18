import {
  ForbiddenException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type {
  AgentCapability,
  AgentMessage,
  TermExitMsg,
  TermOutputMsg,
} from "@tugra/shared";
import { PROTOCOL_VERSION, canonicalCommand, canonicalTermStart, canonicalLogStart, canonicalAgentUpdate } from "@tugra/shared";
import { HubSigningService } from "./hub-signing.service";

/** A sink for one live container-log stream (chunks + terminal exit), keyed by streamId. */
export interface LogListener {
  onChunk(chunk: string): void;
  onExit(exitCode: number): void;
}

/**
 * The terminal gateway registers a delegate so the agent socket can relay
 * interactive-shell traffic without knowing anything about terminals.
 */
export interface TerminalDelegate {
  handleAgentTerminal(serverId: string, msg: TermOutputMsg | TermExitMsg): void;
  handleServerDisconnect(serverId: string): void;
}
import { MetricsService } from "../metrics/metrics.service";
import { ContainerMetricsService } from "../metrics/container-metrics.service";
import { ServersService } from "../servers/servers.service";
import { observedIp } from "../common/observed-ip";

// Trust X-Forwarded-For only when the hub is explicitly behind a reverse proxy;
// otherwise the raw TCP peer address (which an agent cannot spoof) is used.
const TRUST_PROXY = process.env.HUB_TRUSTED_PROXY === "true";

interface ConnState {
  nonce: string;
  serverId?: string;
  authed: boolean;
  remoteIp?: string | null;
}

interface Pending {
  serverId: string;
  resolve: (r: { exitCode: number; output: string }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Raw WebSocket server for agents. Agents dial OUT to /agent (zero inbound port
 * on managed servers). Protocol is the JSON contract in @tugra/shared.
 * Also sends commands to agents (bulk ops / exec) and correlates results.
 */
@Injectable()
export class AgentWsServer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AgentWsServer.name);
  private wss?: WebSocketServer;
  private readonly state = new WeakMap<WebSocket, ConnState>();
  private readonly sockets = new Map<string, WebSocket>(); // serverId → socket
  private readonly pending = new Map<string, Pending>(); // reqId → resolver
  private readonly chunkListeners = new Map<string, (chunk: string) => void>(); // reqId → live log sink
  private readonly logListeners = new Map<string, LogListener>(); // streamId → live container-log sink
  private readonly logStreamsByServer = new Map<string, Set<string>>(); // serverId → streamIds (disconnect teardown)
  private terminalDelegate?: TerminalDelegate;
  // Called when a server comes online so log-drain config can be (re)pushed.
  private logDrainProvider?: (serverId: string) => void;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly servers: ServersService,
    private readonly metrics: MetricsService,
    private readonly containerMetrics: ContainerMetricsService,
    private readonly hubSign: HubSigningService,
  ) {}

  onApplicationBootstrap(): void {
    const httpServer = this.httpAdapterHost.httpAdapter?.getHttpServer();
    if (!httpServer) {
      this.logger.warn("no http server; agent WS not started");
      return;
    }
    // noServer + manual upgrade routing so a second WS server (the terminal
    // gateway) can share this HTTP server without ws aborting each other's
    // handshakes (two {server,path} servers destroy non-matching upgrades).
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (socket: WebSocket, req: import("node:http").IncomingMessage) =>
      this.onConnection(socket, req),
    );
    httpServer.on("upgrade", (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
      const pathname = new URL(req.url ?? "", "ws://localhost").pathname;
      if (pathname !== "/agent") return;
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.wss!.emit("connection", ws, req));
    });
    this.logger.log("agent WS listening on /agent");
    // Push a server's granted capabilities to its connected agent whenever they change, so the
    // agent's fail-closed allowlist updates live (no re-enrollment). On (re)connect the set is
    // (re)sent inside enrolled/auth_ok above. Registered here to avoid a servers→agentWs require
    // cycle (agentWs already depends on servers; servers just holds the callback).
    this.servers.setCapabilityPusher((serverId, capabilities) =>
      this.sendToAgent(serverId, { type: "capabilities", capabilities }),
    );
  }

  private onConnection(socket: WebSocket, req?: import("node:http").IncomingMessage): void {
    const nonce = randomUUID();
    const fwd = req?.headers["x-forwarded-for"];
    const remoteIp = observedIp(
      req?.socket?.remoteAddress,
      Array.isArray(fwd) ? fwd[0] : fwd,
      TRUST_PROXY,
    );
    this.state.set(socket, { nonce, authed: false, remoteIp });
    this.send(socket, { type: "challenge", nonce });

    socket.on("message", (raw) => void this.onMessage(socket, raw.toString()));
    socket.on("close", () => {
      const st = this.state.get(socket);
      if (st?.authed && st.serverId) {
        if (this.sockets.get(st.serverId) === socket) {
          this.sockets.delete(st.serverId);
        }
        this.rejectPendingFor(st.serverId);
        this.failLogStreamsFor(st.serverId);
        this.terminalDelegate?.handleServerDisconnect(st.serverId);
        void this.servers.markOffline(st.serverId);
      }
    });
    socket.on("error", () => undefined);
  }

  private async onMessage(socket: WebSocket, raw: string): Promise<void> {
    const st = this.state.get(socket);
    if (!st) return;

    let msg: AgentMessage;
    try {
      msg = JSON.parse(raw) as AgentMessage;
    } catch {
      return this.fail(socket, "bad json");
    }

    try {
      switch (msg.type) {
        case "enroll": {
          const { serverId, seal } = await this.servers.enroll({
            token: msg.token,
            publicKey: msg.publicKey,
            agentVersion: msg.agentVersion,
            hostname: msg.hostname,
            observedIp: st.remoteIp,
          });
          st.serverId = serverId;
          st.authed = true;
          this.sockets.set(serverId, socket);
          this.send(socket, {
            type: "enrolled",
            serverId,
            seal,
            hubKey: this.hubSign.publicKeySpkiBase64,
            capabilities: await this.servers.grantedCapabilities(serverId),
          });
          this.logDrainProvider?.(serverId);
          return;
        }
        case "auth": {
          const ok = await this.servers.authenticate(
            msg.serverId,
            st.nonce,
            msg.signature,
            st.remoteIp,
            msg.agentVersion,
          );
          if (!ok) return this.fail(socket, "auth failed");
          st.serverId = msg.serverId;
          st.authed = true;
          this.sockets.set(msg.serverId, socket);
          this.send(socket, {
            type: "auth_ok",
            serverId: msg.serverId,
            hubKey: this.hubSign.publicKeySpkiBase64,
            capabilities: await this.servers.grantedCapabilities(msg.serverId),
          });
          this.logDrainProvider?.(msg.serverId);
          return;
        }
        case "metrics": {
          if (!st.authed || !st.serverId) return this.fail(socket, "not authed");
          await this.metrics.ingest(st.serverId, msg.sample);
          return;
        }
        case "container_metrics": {
          if (!st.authed || !st.serverId) return this.fail(socket, "not authed");
          await this.containerMetrics.ingest(st.serverId, msg);
          return;
        }
        case "heartbeat": {
          if (st.authed && st.serverId) await this.servers.touch(st.serverId);
          return;
        }
        case "host_info": {
          if (!st.authed || !st.serverId) return this.fail(socket, "not authed");
          await this.servers.saveHostInfo(st.serverId, msg.info);
          return;
        }
        case "command_log": {
          this.chunkListeners.get(msg.reqId)?.(msg.chunk);
          return;
        }
        case "term_output":
        case "term_exit": {
          if (st.authed && st.serverId) {
            this.terminalDelegate?.handleAgentTerminal(st.serverId, msg);
          }
          return;
        }
        case "log_chunk": {
          if (st.authed && st.serverId) this.logListeners.get(msg.streamId)?.onChunk(msg.chunk);
          return;
        }
        case "log_exit": {
          if (st.authed && st.serverId) this.logListeners.get(msg.streamId)?.onExit(msg.exitCode);
          return;
        }
        case "command_result": {
          const p = this.pending.get(msg.reqId);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(msg.reqId);
            this.chunkListeners.delete(msg.reqId);
            p.resolve({ exitCode: msg.exitCode, output: msg.output });
          }
          return;
        }
        case "agent_update_result": {
          // Pre-handoff self-update outcome (best-effort log). Success is observed via the reconnect's
          // refreshed agentVersion, not here — so we only surface early failures for diagnostics.
          if (!msg.ok) {
            this.logger.warn(
              `agent ${st.serverId} self-update to ${msg.targetVersion} failed at ${msg.phase}: ${msg.error ?? ""}`,
            );
          }
          return;
        }
        default:
          return;
      }
    } catch {
      return this.fail(socket, "rejected");
    }
  }

  /**
   * Send a command to a connected agent and await its result. When onChunk is
   * given, the agent's live command_log chunks are delivered to it as they
   * arrive (used for streaming build logs).
   */
  async sendCommand(
    serverId: string,
    command: string,
    capability: AgentCapability,
    timeoutMs = 20_000,
    onChunk?: (chunk: string) => void,
  ): Promise<{ exitCode: number; output: string }> {
    const socket = this.sockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("agent offline");
    }
    // Hub-side capability grant check BEFORE signing: never sign a command for a capability the
    // server hasn't been granted.
    if (!(await this.isCapabilityGranted(serverId, capability))) {
      throw new ForbiddenException(`capability "${capability}" is not granted for this server`);
    }
    const reqId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        this.chunkListeners.delete(reqId);
        reject(new Error("command timed out"));
      }, timeoutMs);
      // Don't let a stray command timer keep the process alive (clean teardown).
      timer.unref?.();
      this.pending.set(reqId, { serverId, resolve, reject, timer });
      if (onChunk) this.chunkListeners.set(reqId, onChunk);
      this.send(socket, this.signOutbound({ type: "command", reqId, command, timeoutMs, capability }));
    });
  }

  /** Sign command/term_start (capability included) so the agent can verify + scope. */
  private signOutbound(msg: Record<string, unknown>): Record<string, unknown> {
    if (msg.type === "command") {
      msg.sig = this.hubSign.sign(
        canonicalCommand(
          msg.reqId as string,
          msg.command as string,
          msg.timeoutMs as number,
          msg.capability as string,
        ),
      );
    } else if (msg.type === "term_start") {
      msg.sig = this.hubSign.sign(
        canonicalTermStart(
          msg.sessionId as string,
          msg.target as string,
          msg.cols as number,
          msg.rows as number,
          msg.capability as string,
        ),
      );
    } else if (msg.type === "log_start") {
      msg.sig = this.hubSign.sign(
        canonicalLogStart(
          msg.streamId as string,
          msg.target as string,
          msg.tail as number,
          msg.follow as boolean,
          (msg.since as string) ?? "",
          (msg.search as string) ?? "",
          msg.capability as string,
        ),
      );
    } else if (msg.type === "agent_update") {
      msg.sig = this.hubSign.sign(
        canonicalAgentUpdate(
          msg.reqId as string,
          msg.targetVersion as string,
          msg.image as string,
          msg.sha256 as string,
          msg.capability as string,
        ),
      );
    }
    return msg;
  }

  /**
   * Fire-and-forget a signed self-update to a connected agent. Fail-closed on the "deploy" capability
   * (sendToAgent itself does NOT gate). Result is NOT awaited — the agent recreates its container and the
   * new version becomes visible when it reconnects via auth (see ServersService.authenticate). The
   * targetVersion/image/sha256 must come ONLY from the hub's verified manifest, never a caller.
   */
  async sendAgentUpdate(serverId: string, targetVersion: string, image: string, sha256: string): Promise<boolean> {
    if (!(await this.isCapabilityGranted(serverId, "deploy"))) return false;
    return this.sendToAgent(serverId, {
      type: "agent_update",
      reqId: randomUUID(),
      targetVersion,
      image,
      sha256,
      capability: "deploy",
    });
  }

  // ── Live container-log follow ──

  /**
   * Start a signed `docker logs --follow` session on an agent and route its chunks/exit to a
   * listener. Throws (ForbiddenException / "agent offline") if the "logs" capability isn't granted
   * or the agent is down — same fail-closed gate as sendCommand. Returns the minted streamId.
   */
  async startLogStream(
    serverId: string,
    params: { target: string; tail: number; follow: boolean; since?: string; search?: string },
    listener: LogListener,
  ): Promise<string> {
    if (!this.isOnline(serverId)) throw new Error("agent offline");
    if (!(await this.isCapabilityGranted(serverId, "logs"))) {
      throw new ForbiddenException(`capability "logs" is not granted for this server`);
    }
    const streamId = randomUUID();
    this.logListeners.set(streamId, listener);
    (this.logStreamsByServer.get(serverId) ?? this.addLogStreamSet(serverId)).add(streamId);
    // signOutbound signs log_start with canonicalLogStart automatically. The agent may have dropped
    // during the await above (its disconnect teardown ran before this stream was registered), so if
    // delivery fails, end the stream now instead of leaking the listener + slot until max-duration.
    const delivered = this.sendToAgent(serverId, {
      type: "log_start",
      streamId,
      target: params.target,
      tail: params.tail,
      follow: params.follow,
      since: params.since ?? "",
      search: params.search ?? "",
      capability: "logs",
    });
    if (!delivered) {
      this.removeLogStream(serverId, streamId);
      listener.onExit(-1);
    }
    return streamId;
  }

  /** Stop a log stream: tell the agent to kill the process and drop the listener. */
  stopLogStream(serverId: string, streamId: string): void {
    this.sendToAgent(serverId, { type: "log_stop", streamId });
    this.removeLogStream(serverId, streamId);
  }

  private removeLogStream(serverId: string, streamId: string): void {
    this.logListeners.delete(streamId);
    const set = this.logStreamsByServer.get(serverId);
    if (set) {
      set.delete(streamId);
      if (set.size === 0) this.logStreamsByServer.delete(serverId);
    }
  }

  private addLogStreamSet(serverId: string): Set<string> {
    const set = new Set<string>();
    this.logStreamsByServer.set(serverId, set);
    return set;
  }

  /** Register the terminal gateway as the relay for interactive-shell traffic. */
  setTerminalDelegate(delegate: TerminalDelegate): void {
    this.terminalDelegate = delegate;
  }

  /** Register a provider that pushes a server's log-drain config when it connects. */
  setLogDrainProvider(fn: (serverId: string) => void): void {
    this.logDrainProvider = fn;
  }

  /** Fire-and-forget a message to a connected agent. Returns false if offline. */
  sendToAgent(serverId: string, msg: Record<string, unknown>): boolean {
    const socket = this.sockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    this.send(socket, this.signOutbound(msg));
    return true;
  }

  /** Is an agent for this server currently connected? */
  isOnline(serverId: string): boolean {
    const socket = this.sockets.get(serverId);
    return !!socket && socket.readyState === WebSocket.OPEN;
  }

  /** Whether the hub may act on `capability` for this server. The granted set is enforced
   *  verbatim — [] = none (fail-safe), so an unknown/unenrolled server or a fully-revoked one
   *  is denied. Read fresh so a capability toggle applies immediately. */
  async isCapabilityGranted(serverId: string, capability: AgentCapability): Promise<boolean> {
    const granted = await this.servers.grantedCapabilities(serverId);
    return granted.includes(capability);
  }

  /** Reject (and clean up) every pending command for a server that went away. */
  private rejectPendingFor(serverId: string): void {
    for (const [reqId, p] of this.pending) {
      if (p.serverId !== serverId) continue;
      clearTimeout(p.timer);
      this.pending.delete(reqId);
      this.chunkListeners.delete(reqId);
      p.reject(new Error("agent disconnected"));
    }
  }

  /** On agent disconnect, end every live log stream for that server so its SSE client closes
   *  (the agent's process is already gone — there's nothing left to stop). */
  private failLogStreamsFor(serverId: string): void {
    const set = this.logStreamsByServer.get(serverId);
    if (!set) return;
    for (const streamId of [...set]) {
      const listener = this.logListeners.get(streamId);
      this.removeLogStream(serverId, streamId);
      listener?.onExit(-1);
    }
  }

  private send(socket: WebSocket, msg: object): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }

  private fail(socket: WebSocket, message: string): void {
    this.send(socket, { type: "error", message });
    socket.close();
  }

  get protocolVersion(): number {
    return PROTOCOL_VERSION;
  }

  async onModuleDestroy(): Promise<void> {
    this.wss?.close();
  }
}

import {
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
import { PROTOCOL_VERSION, canonicalCommand, canonicalTermStart } from "@tugra/shared";
import { HubSigningService } from "./hub-signing.service";

/**
 * The terminal gateway registers a delegate so the agent socket can relay
 * interactive-shell traffic without knowing anything about terminals.
 */
export interface TerminalDelegate {
  handleAgentTerminal(serverId: string, msg: TermOutputMsg | TermExitMsg): void;
  handleServerDisconnect(serverId: string): void;
}
import { MetricsService } from "../metrics/metrics.service";
import { ServersService } from "../servers/servers.service";

interface ConnState {
  nonce: string;
  serverId?: string;
  authed: boolean;
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
  private terminalDelegate?: TerminalDelegate;
  // Called when a server comes online so log-drain config can be (re)pushed.
  private logDrainProvider?: (serverId: string) => void;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly servers: ServersService,
    private readonly metrics: MetricsService,
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
    this.wss.on("connection", (socket: WebSocket) => this.onConnection(socket));
    httpServer.on("upgrade", (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
      const pathname = new URL(req.url ?? "", "ws://localhost").pathname;
      if (pathname !== "/agent") return;
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.wss!.emit("connection", ws, req));
    });
    this.logger.log("agent WS listening on /agent");
  }

  private onConnection(socket: WebSocket): void {
    const nonce = randomUUID();
    this.state.set(socket, { nonce, authed: false });
    this.send(socket, { type: "challenge", nonce });

    socket.on("message", (raw) => void this.onMessage(socket, raw.toString()));
    socket.on("close", () => {
      const st = this.state.get(socket);
      if (st?.authed && st.serverId) {
        if (this.sockets.get(st.serverId) === socket) {
          this.sockets.delete(st.serverId);
        }
        this.rejectPendingFor(st.serverId);
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
          });
          st.serverId = serverId;
          st.authed = true;
          this.sockets.set(serverId, socket);
          this.send(socket, {
            type: "enrolled",
            serverId,
            seal,
            hubKey: this.hubSign.publicKeySpkiBase64,
          });
          this.logDrainProvider?.(serverId);
          return;
        }
        case "auth": {
          const ok = await this.servers.authenticate(
            msg.serverId,
            st.nonce,
            msg.signature,
          );
          if (!ok) return this.fail(socket, "auth failed");
          st.serverId = msg.serverId;
          st.authed = true;
          this.sockets.set(msg.serverId, socket);
          this.send(socket, {
            type: "auth_ok",
            serverId: msg.serverId,
            hubKey: this.hubSign.publicKeySpkiBase64,
          });
          this.logDrainProvider?.(msg.serverId);
          return;
        }
        case "metrics": {
          if (!st.authed || !st.serverId) return this.fail(socket, "not authed");
          await this.metrics.ingest(st.serverId, msg.sample);
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
  sendCommand(
    serverId: string,
    command: string,
    capability: AgentCapability,
    timeoutMs = 20_000,
    onChunk?: (chunk: string) => void,
  ): Promise<{ exitCode: number; output: string }> {
    const socket = this.sockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("agent offline"));
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
    }
    return msg;
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

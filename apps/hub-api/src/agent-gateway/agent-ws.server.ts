import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentMessage } from "@tugra/shared";
import { PROTOCOL_VERSION } from "@tugra/shared";
import { MetricsService } from "../metrics/metrics.service";
import { ServersService } from "../servers/servers.service";

interface ConnState {
  nonce: string;
  serverId?: string;
  authed: boolean;
}

interface Pending {
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

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly servers: ServersService,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    const httpServer = this.httpAdapterHost.httpAdapter?.getHttpServer();
    if (!httpServer) {
      this.logger.warn("no http server; agent WS not started");
      return;
    }
    this.wss = new WebSocketServer({ server: httpServer, path: "/agent" });
    this.wss.on("connection", (socket: WebSocket) => this.onConnection(socket));
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
          return this.send(socket, { type: "enrolled", serverId, seal });
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
          return this.send(socket, { type: "auth_ok", serverId: msg.serverId });
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
        case "command_result": {
          const p = this.pending.get(msg.reqId);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(msg.reqId);
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

  /** Send a command to a connected agent and await its result. */
  sendCommand(
    serverId: string,
    command: string,
    timeoutMs = 20_000,
  ): Promise<{ exitCode: number; output: string }> {
    const socket = this.sockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("agent offline"));
    }
    const reqId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("command timed out"));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.send(socket, { type: "command", reqId, command });
    });
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

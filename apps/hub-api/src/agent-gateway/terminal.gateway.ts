import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost, ModuleRef } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { TermExitMsg, TermOutputMsg } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { ApiTokensService } from "../api-tokens/api-tokens.service";
import { scopeSatisfies } from "../api-tokens/scopes";
import { AuditService } from "../audit/audit.service";
import { isApiToken } from "../api-tokens/api-token.util";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { observedIp } from "../common/observed-ip";
import { ipMatchesAllowlist } from "../common/ip-allowlist";
import { parseCookies, TG_ACCESS } from "../common/cookies";
import { webBaseUrl } from "../common/web-url";
import type { AccessTokenPayload } from "../auth/strategies/jwt.strategy";
import { containerName } from "../deploy/deploy-script";
import { dbContainerName } from "../databases/database-script";
import { AgentWsServer, type TerminalDelegate } from "./agent-ws.server";
import { SwarmDeployService } from "../clusters/swarm-deploy.service";

const SUBPROTOCOL = "tugra.bearer";

interface Session {
  ws: WebSocket;
  serverId: string;
  userId: string;
}

/**
 * Bidirectional web terminal. A browser opens a WebSocket to /terminal (token
 * carried in the Sec-WebSocket-Protocol header), the hub authenticates + RBAC-
 * checks it, then relays an interactive PTY to/from the target's agent. Terminal
 * = remote code execution → WRITE role required + audited.
 */
@Injectable()
export class TerminalGateway
  implements OnApplicationBootstrap, OnModuleDestroy, TerminalDelegate
{
  private readonly logger = new Logger(TerminalGateway.name);
  private wss?: WebSocketServer;
  private readonly sessions = new Map<string, Session>();
  private readonly byServer = new Map<string, Set<string>>();

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly agentWs: AgentWsServer,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly apiTokens: ApiTokensService,
    private readonly audit: AuditService,
    private readonly instance: InstanceSettingsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    const httpServer = this.httpAdapterHost.httpAdapter?.getHttpServer();
    if (!httpServer) {
      this.logger.warn("no http server; terminal WS not started");
      return;
    }
    // noServer + manual upgrade routing (shares the HTTP server with /agent).
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false,
    });
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      void this.onConnection(ws, req);
    });
    httpServer.on(
      "upgrade",
      (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
        const pathname = new URL(req.url ?? "", "ws://localhost").pathname;
        if (pathname !== "/terminal") return;
        // Defense-in-depth against cross-site WebSocket hijacking: a browser upgrade carries an
        // Origin header we pin to the SPA origin. Non-browser clients (CLI/agent) send no Origin and
        // authenticate with a subprotocol token (never an ambient cookie), so they're allowed.
        if (!this.originAllowed(req)) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => this.wss!.emit("connection", ws, req));
      },
    );
    this.agentWs.setTerminalDelegate(this);
    this.logger.log("terminal WS listening on /terminal");
  }

  private async onConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const userId = await this.authenticate(this.extractToken(req), req);
    if (!userId) return ws.close(1008, "unauthorized");

    const url = new URL(req.url ?? "", "ws://localhost");
    let serverId: string;
    let target: string;
    let auditTarget: string;
    let kind: "container" | "host";
    try {
      const appId = url.searchParams.get("app");
      const serverParam = url.searchParams.get("server");
      if (appId) {
        const app = await this.prisma.application.findUnique({ where: { id: appId } });
        if (!app) return ws.close(1008, "not found");
        await this.access.requirePermission(userId, app.teamId, 'terminal');
        serverId = app.serverId;
        if (app.clusterId) {
          // Swarm app: exec into a RUNNING replica on whichever node hosts it (resolved via the manager) —
          // NOT app.serverId (only an anchor). resolveTaskExec picks an ONLINE node with "terminal" granted.
          const swarmDeploy = this.moduleRef.get(SwarmDeployService, { strict: false });
          try {
            const picked = await swarmDeploy.resolveTaskExec(app);
            serverId = picked.serverId;
            target = picked.container;
          } catch (e) {
            // Surface the specific reason (e.g. "grant 'terminal' to a node…") instead of a generic close.
            return ws.close(1011, (e instanceof Error ? e.message : "could not resolve a replica").slice(0, 120));
          }
        } else if (app.source === "COMPOSE") {
          // Compose stacks have multiple containers — the caller picks one.
          // Validate it belongs to THIS app's project (can't exec into others).
          const container = url.searchParams.get("container") ?? "";
          const prefix = `tugra_${app.id}`;
          if (container !== prefix && !container.startsWith(`${prefix}-`)) {
            return ws.close(1008, "invalid container");
          }
          target = container;
        } else {
          target = containerName(app);
        }
        auditTarget = app.id;
        kind = "container";
      } else if (url.searchParams.get("database")) {
        const dbId = url.searchParams.get("database")!;
        const db = await this.prisma.database.findUnique({ where: { id: dbId } });
        if (!db) return ws.close(1008, "not found");
        await this.access.requirePermission(userId, db.teamId, 'terminal');
        serverId = db.serverId;
        target = dbContainerName(db);
        auditTarget = db.id;
        kind = "container";
      } else if (serverParam) {
        const server = await this.prisma.server.findUnique({ where: { id: serverParam } });
        if (!server) return ws.close(1008, "not found");
        await this.access.requirePermission(userId, server.teamId, 'terminal');
        serverId = server.id;
        target = "";
        auditTarget = server.id;
        kind = "host";
      } else {
        return ws.close(1008, "no target");
      }
    } catch {
      return ws.close(1008, "forbidden");
    }

    if (!this.agentWs.isOnline(serverId)) return ws.close(1011, "agent offline");
    // The terminal capability must be granted for this server (off by default, least privilege).
    if (!(await this.agentWs.isCapabilityGranted(serverId, "terminal"))) {
      return ws.close(1008, "terminal capability not granted for this server");
    }

    const sessionId = randomUUID();
    const cols = toSize(url.searchParams.get("cols"), 80);
    const rows = toSize(url.searchParams.get("rows"), 24);
    this.sessions.set(sessionId, { ws, serverId, userId });
    (this.byServer.get(serverId) ?? this.addServerSet(serverId)).add(sessionId);
    await this.audit.log({ actor: userId, action: "terminal.open", target: auditTarget, meta: { kind } });
    this.agentWs.sendToAgent(serverId, { type: "term_start", sessionId, target, cols, rows, capability: "terminal" });

    ws.on("message", (raw) => this.onClientMessage(sessionId, serverId, raw.toString()));
    ws.on("close", () => this.endSession(sessionId, true));
    ws.on("error", () => this.endSession(sessionId, true));

    // Keep the socket alive through idle-timeout proxies (Cloudflare/Traefik ~100s): a server-driven ping
    // every 25s (the browser auto-replies pong). Two consecutive missed pongs ⇒ the peer is gone → terminate.
    let pongMissed = 0;
    ws.on("pong", () => { pongMissed = 0; });
    const heartbeat = setInterval(() => {
      // Self-clear when the socket is gone or the ws impl has no ping (test mocks) — so a dangling 25s
      // timer never fires ws.ping() on a non-ws object and never keeps a jest worker alive.
      if (typeof ws.ping !== "function" || ws.readyState !== WebSocket.OPEN) return clearInterval(heartbeat);
      if (pongMissed >= 2) { clearInterval(heartbeat); return ws.terminate(); }
      pongMissed += 1;
      ws.ping();
    }, 25_000);
    heartbeat.unref?.();
    ws.on("close", () => clearInterval(heartbeat));
  }

  private onClientMessage(sessionId: string, serverId: string, raw: string): void {
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "term_input") {
      this.agentWs.sendToAgent(serverId, { type: "term_input", sessionId, data: String(msg.data ?? "") });
    } else if (msg.type === "term_resize") {
      this.agentWs.sendToAgent(serverId, {
        type: "term_resize",
        sessionId,
        cols: toSize(msg.cols, 80),
        rows: toSize(msg.rows, 24),
      });
    } else if (msg.type === "term_close") {
      this.endSession(sessionId, true);
    }
  }

  // ── TerminalDelegate (called by AgentWsServer) ──

  handleAgentTerminal(_serverId: string, msg: TermOutputMsg | TermExitMsg): void {
    const sess = this.sessions.get(msg.sessionId);
    if (!sess) return;
    if (sess.ws.readyState === WebSocket.OPEN) sess.ws.send(JSON.stringify(msg));
    if (msg.type === "term_exit") {
      if (sess.ws.readyState === WebSocket.OPEN) sess.ws.close(1000, "exited");
      this.removeSession(msg.sessionId);
    }
  }

  handleServerDisconnect(serverId: string): void {
    const ids = this.byServer.get(serverId);
    if (!ids) return;
    for (const id of [...ids]) {
      const sess = this.sessions.get(id);
      if (sess && sess.ws.readyState === WebSocket.OPEN) sess.ws.close(1011, "agent disconnected");
      this.removeSession(id);
    }
  }

  // ── helpers ──

  private endSession(sessionId: string, notifyAgent: boolean): void {
    const sess = this.sessions.get(sessionId);
    if (!sess) return;
    if (notifyAgent) this.agentWs.sendToAgent(sess.serverId, { type: "term_close", sessionId });
    this.removeSession(sessionId);
  }

  private removeSession(sessionId: string): void {
    const sess = this.sessions.get(sessionId);
    if (!sess) return;
    this.sessions.delete(sessionId);
    const set = this.byServer.get(sess.serverId);
    if (set) {
      set.delete(sessionId);
      if (set.size === 0) this.byServer.delete(sess.serverId);
    }
  }

  private addServerSet(serverId: string): Set<string> {
    const set = new Set<string>();
    this.byServer.set(serverId, set);
    return set;
  }

  private async authenticate(token: string, req: IncomingMessage): Promise<string | null> {
    if (!token) return null;
    if (isApiToken(token)) {
      const u = await this.apiTokens.validate(token);
      if (!u) return null;
      // An interactive root shell is the single most powerful PAT capability, so it requires the
      // highest scope — a read/write/deploy token must NOT open a terminal. (The HTTP guard pipeline
      // never ran for this WS entry point, so the scope check is enforced here explicitly.)
      if (!scopeSatisfies(u.scopes ?? [], "admin")) return null;
      // The terminal is a PAT entry point outside the HTTP guard pipeline, so it must apply the SAME
      // instance-level API gating as ApiAuthGuard — otherwise the kill-switch / IP allowlist wouldn't
      // cover the most sensitive PAT capability (an interactive server shell).
      const settings = await this.instance.get();
      if (!settings.apiEnabled) return null;
      if (settings.apiAllowedIps.length > 0) {
        const fwd = req.headers["x-forwarded-for"];
        const ip = observedIp(
          req.socket?.remoteAddress,
          Array.isArray(fwd) ? fwd[0] : fwd,
          process.env.HUB_TRUSTED_PROXY === "true",
        );
        if (!ip || !ipMatchesAllowlist(ip, settings.apiAllowedIps)) return null;
      }
      return u.userId;
    }
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload | { sub: string; type: string }>(token, {
        secret: this.config.get<string>("JWT_ACCESS_SECRET"),
      });
      // Accept a normal access JWT (bearer/cookie) OR a short-lived terminal ticket (subprotocol).
      return payload.type === "access" || payload.type === "term_ticket" ? payload.sub : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether a WS upgrade's Origin is allowed. Missing Origin → non-browser client (CLI/agent),
   * allowed. Present Origin → must equal the SPA origin, blocking cross-site WebSocket hijacking of
   * a cookie/ticket session from any other (even same-site sibling) origin.
   */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).origin === new URL(webBaseUrl(this.config)).origin;
    } catch {
      return false;
    }
  }

  private extractToken(req: IncomingMessage): string {
    // Subprotocol carries a bearer/PAT/term_ticket token; on a same-origin browser upgrade the
    // access JWT rides in the httpOnly cookie instead (JS can't set the subprotocol from a cookie).
    const header = req.headers["sec-websocket-protocol"];
    if (header) {
      const parts = (Array.isArray(header) ? header.join(",") : header)
        .split(",")
        .map((s) => s.trim());
      const idx = parts.indexOf(SUBPROTOCOL);
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    }
    return parseCookies(req.headers.cookie)[TG_ACCESS] ?? "";
  }

  onModuleDestroy(): void {
    this.wss?.close();
  }
}

function toSize(v: string | number | null | undefined, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 && n <= 1000 ? Math.floor(n) : fallback;
}

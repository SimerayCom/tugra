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
  CommandStateMsg,
  FsEntry,
  TermExitMsg,
  TermOutputMsg,
} from "@tugra/shared";
import { PROTOCOL_VERSION, checkAgentCompat, canonicalCommand, canonicalCommandCancel, canonicalCommandStatus, canonicalTermStart, canonicalLogStart, canonicalAgentUpdate, canonicalFs } from "@tugra/shared";
import { HubSigningService } from "./hub-signing.service";
import { AgentCommandTimeoutException, AgentDisconnectedException, AgentOfflineException } from "./agent-offline.exception";

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
import { TrafficMetricsService } from "../traffic/traffic-metrics.service";
import { ServersService } from "../servers/servers.service";
import { observedIp } from "../common/observed-ip";

/** Normalize an agent's advertised feature list (bounded, strings only). */
function featureSet(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(raw)) for (const f of raw.slice(0, 32)) if (typeof f === "string" && f.length <= 64) out.add(f);
  return out;
}

// Trust X-Forwarded-For only when the hub is explicitly behind a reverse proxy;
// otherwise the raw TCP peer address (which an agent cannot spoof) is used.
const TRUST_PROXY = process.env.HUB_TRUSTED_PROXY === "true";

// ws keepalive sweep period. Each tick pings every socket and terminates one that didn't pong since the
// last tick — so a half-open TCP (a crashed/partitioned box that never sent a close) is detected within
// ~one interval and the server flips OFFLINE, instead of sitting ONLINE forever.
const PING_INTERVAL_MS = 30_000;

// Close a connection that has not authenticated within this window, so an unauthenticated peer can't camp on
// a socket (default 10s — a real agent signs the challenge in well under a second). Env-overridable.
const AUTH_DEADLINE_MS = Number(process.env.AGENT_WS_AUTH_DEADLINE_MS) || 10_000;
// Cap a single inbound frame (the ws default is 100 MiB). Generous for real agent messages (metrics, command
// output, log chunks) while denying a multi-hundred-MB frame — especially from an unauthenticated peer, whose
// only legitimate messages (enroll/auth) are tiny. Env-overridable.
const MAX_PAYLOAD_BYTES = Number(process.env.AGENT_WS_MAX_PAYLOAD_BYTES) || 64 * 1024 * 1024;

interface ConnState {
  nonce: string;
  serverId?: string;
  authed: boolean;
  remoteIp?: string | null;
  isAlive: boolean; // ws keepalive: pong flips it true; the ping sweep terminates a socket that missed one
  authTimer?: ReturnType<typeof setTimeout>; // pre-auth deadline; cleared on auth/enroll/close
  /** Per-feature flags the agent advertised in enroll/auth (e.g. cmd_journal_v1). Empty for older agents. */
  features: Set<string>;
}

/** Options for sendCommand beyond the positional parameters (all optional; the legacy call shape is unchanged). */
export interface SendCommandOptions {
  /** Caller-chosen reqId (must be unique per hub; used as the agent's journal key). Default: a fresh UUID. */
  reqId?: string;
  /** Mark the command `durable` so a cmd_journal_v1 agent journals it (survives a socket drop, never re-run). */
  durable?: boolean;
  /** Awaited AFTER the online + capability checks and BEFORE the frame is written; a throw aborts the send (nothing
   *  reaches the agent). Lets a caller persist the reqId with a compare-and-set so a crash can never leave a
   *  dispatched command the DB does not know about. */
  beforeSend?: (reqId: string) => Promise<void>;
}

/** What adoptCommand resolved to. */
export type AdoptedCommand =
  | { kind: "result"; exitCode: number; output: string; killed: boolean }
  | { kind: "interrupted"; output: string }
  | { kind: "unknown" }
  | { kind: "no_reply" };

interface StatePending {
  serverId: string;
  resolve: (r: CommandStateMsg | null) => void;
  timer: NodeJS.Timeout;
}

/** Extra hub-side slack over the agent's own timeout for a durable command, so the agent's timeout result (a
 *  real exit code + output) arrives before the hub gives up on its own. */
export const DURABLE_TIMEOUT_SLACK_MS = 15_000;

interface Pending {
  serverId: string;
  resolve: (r: { exitCode: number; output: string }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** The result of one file op: metadata-only listing, or an error. */
export interface FsListing {
  entries: FsEntry[];
  truncated: boolean;
}

interface FsPending {
  serverId: string;
  resolve: (r: FsListing) => void;
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
  private pingTimer?: ReturnType<typeof setInterval>;
  private readonly state = new WeakMap<WebSocket, ConnState>();
  private readonly sockets = new Map<string, WebSocket>(); // serverId → socket
  private readonly pending = new Map<string, Pending>(); // reqId → resolver
  private readonly fsPending = new Map<string, FsPending>(); // reqId → file-op resolver
  private readonly statePending = new Map<string, StatePending>(); // reqId → command_status resolver
  private readonly chunkListeners = new Map<string, (chunk: string) => void>(); // reqId → live log sink
  private readonly logListeners = new Map<string, LogListener>(); // streamId → live container-log sink
  private readonly logStreamsByServer = new Map<string, Set<string>>(); // serverId → streamIds (disconnect teardown)
  private terminalDelegate?: TerminalDelegate;
  // Called when a server comes online so log-drain config can be (re)pushed.
  private logDrainProvider?: (serverId: string) => void;
  // Called when a server's agent (re)connects so its QUEUED deploys can be re-driven now that the agent is
  // online again (a hub restart no longer drops queued deploys). Mirrors logDrainProvider's on-online
  // piggyback; invoked AFTER this.sockets.set(...), so isOnline(serverId) is already true in the callback.
  private deployReDriveProvider?: (serverId: string) => void;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly servers: ServersService,
    private readonly metrics: MetricsService,
    private readonly containerMetrics: ContainerMetricsService,
    private readonly hubSign: HubSigningService,
    private readonly traffic: TrafficMetricsService,
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
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
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

    // ws keepalive: ping every socket each interval; terminate one that didn't pong since the last tick.
    // terminate() fires `close`, which runs the same teardown as a graceful drop (markOffline + reject
    // pending), so a half-open connection can no longer leave a server stuck ONLINE.
    this.pingTimer = setInterval(() => this.keepaliveSweep(), PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  /** One keepalive tick: terminate any socket that didn't pong since the last tick (dead / half-open),
   *  otherwise mark it pending-pong and ping it. Extracted so it is unit-testable without a timer. */
  keepaliveSweep(): void {
    for (const socket of this.wss?.clients ?? []) {
      const st = this.state.get(socket);
      if (!st || st.isAlive === false) {
        socket.terminate();
        continue;
      }
      st.isAlive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }

  /** Close a socket that is still unauthenticated when the handshake deadline fires. Extracted so the
   *  decision is unit-testable without a real timer (mirrors keepaliveSweep). */
  closeIfUnauthed(socket: WebSocket): void {
    const st = this.state.get(socket);
    if (!st || st.authed) return;
    this.logger.warn(`agent handshake timeout from ${st.remoteIp ?? "?"} — closing unauthenticated socket`);
    try {
      socket.close(1008, "auth timeout");
    } catch {
      socket.terminate();
    }
  }

  private clearAuthTimer(st: ConnState): void {
    if (st.authTimer) {
      clearTimeout(st.authTimer);
      st.authTimer = undefined;
    }
  }

  private onConnection(socket: WebSocket, req?: import("node:http").IncomingMessage): void {
    const nonce = randomUUID();
    const fwd = req?.headers["x-forwarded-for"];
    const remoteIp = observedIp(
      req?.socket?.remoteAddress,
      Array.isArray(fwd) ? fwd[0] : fwd,
      TRUST_PROXY,
    );
    // Close the socket if it hasn't authenticated by the deadline (an unauthenticated peer can otherwise
    // hold a connection open indefinitely). Cleared on successful enroll/auth and on close.
    const authTimer = setTimeout(() => this.closeIfUnauthed(socket), AUTH_DEADLINE_MS);
    authTimer.unref?.();
    this.state.set(socket, { nonce, authed: false, remoteIp, isAlive: true, authTimer, features: new Set() });
    this.send(socket, { type: "challenge", nonce });

    // ws keepalive: a pong marks the socket alive again for the next sweep (see startKeepalive).
    socket.on("pong", () => {
      const s = this.state.get(socket);
      if (s) s.isAlive = true;
    });
    socket.on("message", (raw) => void this.onMessage(socket, raw.toString()));
    socket.on("close", () => {
      const st = this.state.get(socket);
      if (st) this.clearAuthTimer(st);
      // Act ONLY if this socket is still the CURRENT connection for the server. A superseded socket's late
      // close (e.g. a half-open connection the keepalive terminates ~60s after the agent already reconnected
      // on a fresh socket) must NOT flip a live agent OFFLINE, nor reject the NEW socket's pending commands /
      // kill its terminals. The replaced socket's own resources were already torn down at supersede time.
      if (st?.authed && st.serverId && this.sockets.get(st.serverId) === socket) {
        this.sockets.delete(st.serverId);
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
          // Compatibility gate BEFORE enroll so an incompatible agent never consumes its one-time token.
          if (this.rejectedForCompat(socket, msg.protocol, msg.agentVersion, `enroll from ${st.remoteIp ?? "?"}`)) return;
          const { serverId, seal } = await this.servers.enroll({
            token: msg.token,
            publicKey: msg.publicKey,
            agentVersion: msg.agentVersion,
            hostname: msg.hostname,
            observedIp: st.remoteIp,
          });
          st.serverId = serverId;
          st.authed = true;
          st.features = featureSet(msg.features);
          this.clearAuthTimer(st);
          this.adoptSocket(serverId, socket);
          // Re-assert ONLINE on the live socket: if a prior socket closed during the enroll/auth await, its
          // close handler may have landed markOffline AFTER the status write — heal it immediately (conditional,
          // no notification) rather than waiting for the next heartbeat.
          await this.servers.healOnline(serverId);
          this.send(socket, {
            type: "enrolled",
            serverId,
            seal,
            hubKey: this.hubSign.publicKeySpkiBase64,
            capabilities: await this.servers.grantedCapabilities(serverId),
          });
          this.logDrainProvider?.(serverId);
          this.deployReDriveProvider?.(serverId);
          return;
        }
        case "auth": {
          // Compatibility gate BEFORE authenticate so an incompatible agent never flips the server ONLINE.
          // serverId is attacker-controlled on an unauthenticated socket — bound it before it reaches the log.
          if (this.rejectedForCompat(socket, msg.protocol, msg.agentVersion, `auth for server ${String(msg.serverId).slice(0, 64).replace(/[^\x20-\x7e]/g, "?")}`)) return;
          const res = await this.servers.authenticate(
            msg.serverId,
            st.nonce,
            msg.signature,
            st.remoteIp,
            msg.agentVersion,
          );
          if (res !== "ok") {
            // Only "unknown" (the server row is gone / never enrolled) tells the agent to re-enroll; a
            // bad signature on a known server is a generic rejection so the agent keeps its identity.
            if (res === "unknown") return this.fail(socket, "reenroll", "reenroll");
            // Surface a persistent bad-signature (e.g. a key/volume restored from a different server):
            // the agent keeps retrying with the same bad key, so without this the server just shows
            // OFFLINE with no hint why.
            this.logger.warn(`agent auth rejected (bad signature) for server ${msg.serverId} from ${st.remoteIp ?? "?"}`);
            return this.fail(socket, "auth failed");
          }
          st.serverId = msg.serverId;
          st.authed = true;
          st.features = featureSet(msg.features);
          this.clearAuthTimer(st);
          this.adoptSocket(msg.serverId, socket);
          // Re-assert ONLINE on the live socket (see the enroll path): a prior socket closing during the auth
          // await could otherwise land markOffline after authenticate's markOnline, leaving a live agent OFFLINE.
          await this.servers.healOnline(msg.serverId);
          this.send(socket, {
            type: "auth_ok",
            serverId: msg.serverId,
            hubKey: this.hubSign.publicKeySpkiBase64,
            capabilities: await this.servers.grantedCapabilities(msg.serverId),
          });
          this.logDrainProvider?.(msg.serverId);
          this.deployReDriveProvider?.(msg.serverId);
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
        case "traffic_metrics": {
          if (!st.authed || !st.serverId) return this.fail(socket, "not authed");
          // serverId is the authenticated socket's, never the message body's. ingest() never throws.
          await this.traffic.ingest(st.serverId, msg);
          return;
        }
        case "heartbeat": {
          // Only the current socket's heartbeat counts. Touch lastSeenAt, and self-heal a stale status: if a
          // live agent socket exists but the row is not ONLINE (a reconnect race or a hub restart left it
          // OFFLINE), flip it back — no server_online notification (reconciling truth, not a real edge).
          if (st.authed && st.serverId && this.sockets.get(st.serverId) === socket) {
            await this.servers.touch(st.serverId);
            // Re-check AFTER the touch round-trip: if this socket closed meanwhile, its close handler already
            // ran markOffline — healing unconditionally would resurrect a now-dead server (no socket, nothing
            // to re-correct it, no lastSeenAt sweeper). Only heal while we are still the current socket.
            if (this.sockets.get(st.serverId) === socket) await this.servers.healOnline(st.serverId);
          }
          return;
        }
        case "host_info": {
          if (!st.authed || !st.serverId) return this.fail(socket, "not authed");
          await this.servers.saveHostInfo(st.serverId, msg.info);
          return;
        }
        case "command_log": {
          // Bound like command_result: only the authed socket of the server the command was sent to may feed its
          // live log (deploy reqIds are now predictable `dep-<id>`, so an unbound sink would let any socket inject
          // lines — including fake TUGRA markers — into another server's deploy stream).
          if (!st.authed || !st.serverId) return;
          const p = this.pending.get(msg.reqId);
          if (!p || p.serverId !== st.serverId) return;
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
          // Only the authed socket of the server the command was sent to may resolve it (fs_result isolation):
          // a reply relayed by a different agent must never settle another server's command.
          if (!st.authed || !st.serverId) return;
          const p = this.pending.get(msg.reqId);
          if (p && p.serverId === st.serverId) {
            clearTimeout(p.timer);
            this.pending.delete(msg.reqId);
            this.chunkListeners.delete(msg.reqId);
            p.resolve({ exitCode: msg.exitCode, output: msg.output });
          }
          return;
        }
        case "command_state": {
          if (!st.authed || !st.serverId) return;
          const p = this.statePending.get(msg.reqId);
          if (!p || p.serverId !== st.serverId) return;
          clearTimeout(p.timer);
          this.statePending.delete(msg.reqId);
          p.resolve(msg);
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
        case "fs_result": {
          // Only accept a reply on an authed socket, and only for a request WE registered for THIS server
          // (a reply from a different agent must never resolve another's pending file op).
          if (!st.authed || !st.serverId) return;
          const p = this.fsPending.get(msg.reqId);
          if (!p || p.serverId !== st.serverId) return;
          clearTimeout(p.timer);
          this.fsPending.delete(msg.reqId);
          if (msg.ok) {
            p.resolve({ entries: msg.entries ?? [], truncated: msg.truncated ?? false });
          } else {
            p.reject(new Error(msg.error || "file operation failed"));
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
    onStart?: (reqId: string) => void,
    opts: SendCommandOptions = {},
  ): Promise<{ exitCode: number; output: string }> {
    const socket = this.sockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      // Typed so an HTTP-reached caller gets a clean 503 (not a masked 500). Still an Error whose
      // message contains "offline", so catch/message callers and schedulers are unaffected.
      throw new AgentOfflineException();
    }
    // Hub-side capability grant check BEFORE signing: never sign a command for a capability the
    // server hasn't been granted.
    if (!(await this.isCapabilityGranted(serverId, capability))) {
      throw new ForbiddenException(`capability "${capability}" is not granted for this server`);
    }
    const reqId = opts.reqId ?? randomUUID();
    if (this.pending.has(reqId)) throw new Error(`a command with reqId ${reqId} is already in flight`);
    // Persist-before-send hook (durable deploys): a throw here aborts BEFORE anything reaches the agent, so a
    // crash can never leave a dispatched command the DB does not know about.
    if (opts.beforeSend) await opts.beforeSend(reqId);
    // Re-check the socket: the await above may have outlived the connection.
    const live = this.sockets.get(serverId);
    if (!live || live.readyState !== WebSocket.OPEN) throw new AgentOfflineException();
    const durable = opts.durable === true;
    const hubTimeoutMs = durable ? timeoutMs + DURABLE_TIMEOUT_SLACK_MS : timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        this.chunkListeners.delete(reqId);
        reject(new AgentCommandTimeoutException("command timed out"));
      }, hubTimeoutMs);
      // Don't let a stray command timer keep the process alive (clean teardown).
      timer.unref?.();
      this.pending.set(reqId, { serverId, resolve, reject, timer });
      if (onChunk) this.chunkListeners.set(reqId, onChunk);
      this.send(live, this.signOutbound({ type: "command", reqId, command, timeoutMs, capability, ...(durable ? { durable: true } : {}) }));
      // Expose the reqId to the caller AFTER the command is on the wire, so a cancel can target it.
      onStart?.(reqId);
    });
  }

  /** Does the connected agent for this server advertise a feature flag (e.g. cmd_journal_v1)? False when offline
   *  or for an older agent that sent none — callers then take the legacy path. */
  agentSupports(serverId: string, feature: string): boolean {
    const socket = this.sockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    return this.state.get(socket)?.features.has(feature) ?? false;
  }

  /**
   * Ask a cmd_journal_v1 agent what happened to a durable command (signed command_status → command_state). Resolves
   * null when the agent does not answer within timeoutMs (an old agent ignores the unknown type) and rejects with
   * AgentDisconnectedException if its socket drops meanwhile. Read-only: the agent never re-runs anything.
   */
  queryCommand(serverId: string, reqId: string, timeoutMs = 10_000): Promise<CommandStateMsg | null> {
    const socket = this.sockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new AgentOfflineException();
    return new Promise<CommandStateMsg | null>((resolve) => {
      const timer = setTimeout(() => {
        this.statePending.delete(reqId);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.statePending.set(reqId, { serverId, resolve, timer });
      this.send(socket, this.signOutbound({ type: "command_status", reqId }));
    });
  }

  /**
   * Adopt a durable command another hub process dispatched: register the result/chunk listeners FIRST (so a
   * command_result racing the status query is never lost), ask the agent for its state, then either return the
   * journaled result (done), await the live command_result until `deadlineMs` (running), or report that the
   * outcome cannot be known (interrupted / unknown / no reply from an old agent). Rejects with
   * AgentDisconnectedException if the agent drops while we wait, so the caller can release the lease again.
   */
  async adoptCommand(serverId: string, reqId: string, onChunk: (chunk: string) => void, deadlineMs: number): Promise<AdoptedCommand> {
    const socket = this.sockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new AgentOfflineException();
    if (this.pending.has(reqId)) throw new Error(`a command with reqId ${reqId} is already in flight`);
    let settle!: (r: AdoptedCommand) => void;
    let fail!: (e: Error) => void;
    const outcome = new Promise<AdoptedCommand>((res, rej) => {
      settle = res;
      fail = rej;
    });
    const timer = setTimeout(() => {
      this.pending.delete(reqId);
      this.chunkListeners.delete(reqId);
      settle({ kind: "no_reply" });
    }, Math.max(1_000, deadlineMs));
    timer.unref?.();
    // The pending entry resolves on the LIVE command_result (running case). Its killed flag is unknown on that
    // path (the live frame has none), so a follow-up status query fills it in below.
    this.pending.set(reqId, {
      serverId,
      resolve: ({ exitCode, output }) => void this.finishAdopted(serverId, reqId, exitCode, output).then(settle, fail),
      reject: fail,
      timer,
    });
    this.chunkListeners.set(reqId, onChunk);
    // Race the status query against the live outcome: a command_result (or a drop / the deadline) that lands
    // while we ask must win immediately rather than wait out the query timer.
    type Step = { t: "state"; s: CommandStateMsg | null } | { t: "out"; o: AdoptedCommand } | { t: "err"; e: unknown };
    const step: Step = await Promise.race([
      this.queryCommand(serverId, reqId).then(
        (s): Step => ({ t: "state", s }),
        (e): Step => ({ t: "err", e }),
      ),
      outcome.then(
        (o): Step => ({ t: "out", o }),
        (e): Step => ({ t: "err", e }),
      ),
    ]);
    if (step.t === "out") {
      this.dropStatePending(reqId);
      return step.o;
    }
    if (step.t === "err") {
      this.dropPending(reqId);
      this.dropStatePending(reqId);
      throw step.e;
    }
    const state = step.s;
    if (!this.pending.has(reqId)) return outcome; // the live result already landed while we asked
    if (!state) {
      this.dropPending(reqId);
      return { kind: "no_reply" };
    }
    switch (state.state) {
      case "done":
        this.dropPending(reqId);
        return { kind: "result", exitCode: state.exitCode ?? -1, output: state.output ?? "", killed: state.killed === true };
      case "running":
        // Seed the live stream with what ran so far, then wait for command_result (or the deadline / a drop).
        if (state.output) onChunk(state.output);
        return outcome;
      case "interrupted":
        this.dropPending(reqId);
        return { kind: "interrupted", output: state.output ?? "" };
      default:
        this.dropPending(reqId);
        return { kind: "unknown" };
    }
  }

  /** After a live command_result during adoption, ask the journal whether it was a cancel kill (best-effort). */
  private async finishAdopted(serverId: string, reqId: string, exitCode: number, output: string): Promise<AdoptedCommand> {
    let killed = false;
    if (exitCode !== 0) {
      try {
        const st = await this.queryCommand(serverId, reqId, 5_000);
        killed = st?.state === "done" && st.killed === true;
      } catch {
        /* best-effort: a drop here leaves killed=false (FAILED, never a false CANCELLED) */
      }
    }
    return { kind: "result", exitCode, output, killed };
  }

  private dropStatePending(reqId: string): void {
    const p = this.statePending.get(reqId);
    if (p) clearTimeout(p.timer);
    this.statePending.delete(reqId);
  }

  private dropPending(reqId: string): void {
    const p = this.pending.get(reqId);
    if (p) clearTimeout(p.timer);
    this.pending.delete(reqId);
    this.chunkListeners.delete(reqId);
  }

  /** Cancel an in-flight command by reqId — signs a `command_cancel` the agent verifies, then kills that
   *  command's process group. Best-effort + fire-and-forget: the original command's `command_result` still
   *  arrives (with a non-zero exit) and resolves its sendCommand promise. Returns false (no-op) if the agent is
   *  offline, so a caller that needs the kill to have been delivered can refuse instead of pretending. */
  cancelCommand(serverId: string, reqId: string): boolean {
    const socket = this.sockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    this.send(socket, this.signOutbound({ type: "command_cancel", reqId }));
    return true;
  }

  /**
   * Send a signed file operation to a connected agent and await its result. Fail-closed on
   * the "files" capability: never sign an fs_req for a server that hasn't been granted it. The agent runs
   * the op inside a sandboxed, read-only helper container; this only ever returns metadata, never content.
   */
  async sendFsReq(serverId: string, op: "list", volume: string, path: string, timeoutMs = 35_000): Promise<FsListing> {
    const socket = this.sockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new AgentOfflineException();
    }
    const capability: AgentCapability = "files";
    if (!(await this.isCapabilityGranted(serverId, capability))) {
      throw new ForbiddenException(`capability "${capability}" is not granted for this server`);
    }
    const reqId = randomUUID();
    return new Promise<FsListing>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fsPending.delete(reqId);
        reject(new AgentCommandTimeoutException("file operation timed out"));
      }, timeoutMs);
      timer.unref?.();
      this.fsPending.set(reqId, { serverId, resolve, reject, timer });
      this.send(socket, this.signOutbound({ type: "fs_req", reqId, op, volume, path, capability }));
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
    } else if (msg.type === "command_cancel") {
      msg.sig = this.hubSign.sign(canonicalCommandCancel(msg.reqId as string));
    } else if (msg.type === "command_status") {
      msg.sig = this.hubSign.sign(canonicalCommandStatus(msg.reqId as string));
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
    } else if (msg.type === "fs_req") {
      msg.sig = this.hubSign.sign(
        canonicalFs(
          msg.reqId as string,
          msg.op as string,
          msg.volume as string,
          msg.path as string,
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
    params: { target: string; tail: number; follow: boolean; since?: string; search?: string; service?: boolean },
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
      // Swarm apps: follow `docker service logs` (aggregated across replicas). Not signed — see LogStartMsg.
      service: params.service ?? false,
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

  /** Register a provider that re-drives a server's QUEUED deploys when its agent (re)connects. Invoked on
   *  every (re)connect right after the socket is registered, so the callback's online gate holds by
   *  construction (isOnline(serverId) === true). */
  setDeployReDriveProvider(fn: (serverId: string) => void): void {
    this.deployReDriveProvider = fn;
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

  /**
   * Make `socket` the CURRENT connection for `serverId`, superseding any prior socket. The agent reconnected
   * (new socket) while an old one may still be half-open; tear the OLD connection's resources down ONCE here
   * (they belong to the replaced socket; the new socket has no pending work yet) and terminate it. Its later
   * close is then inert because the close handler only acts for the current socket. Called from enroll + auth;
   * the caller then re-asserts ONLINE (healOnline) to close the window where a prior socket's late close could
   * land markOffline after the status write.
   */
  private adoptSocket(serverId: string, socket: WebSocket): void {
    const prev = this.sockets.get(serverId);
    if (prev && prev !== socket) {
      this.rejectPendingFor(serverId);
      this.failLogStreamsFor(serverId);
      this.terminalDelegate?.handleServerDisconnect(serverId);
      prev.terminate();
    }
    this.sockets.set(serverId, socket);
  }

  /** Reject (and clean up) every pending command for a server that went away. */
  private rejectPendingFor(serverId: string): void {
    for (const [reqId, p] of this.pending) {
      if (p.serverId !== serverId) continue;
      clearTimeout(p.timer);
      this.pending.delete(reqId);
      this.chunkListeners.delete(reqId);
      p.reject(new AgentDisconnectedException("agent disconnected"));
    }
    for (const [reqId, p] of this.fsPending) {
      if (p.serverId !== serverId) continue;
      clearTimeout(p.timer);
      this.fsPending.delete(reqId);
      p.reject(new AgentDisconnectedException("agent disconnected"));
    }
    for (const [reqId, p] of this.statePending) {
      if (p.serverId !== serverId) continue;
      clearTimeout(p.timer);
      this.statePending.delete(reqId);
      p.resolve(null); // no answer from a connection that is gone; adoptCommand's own pending reject carries the drop
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

  private fail(socket: WebSocket, message: string, code?: string, closeCode?: number): void {
    // `code` is an optional machine-readable reason. "reenroll" tells an agent to discard its identity;
    // "agent_incompatible" tells it to keep its identity and update. `closeCode` sets the WS close status
    // (e.g. 1008 policy-violation for an incompatible agent); omitted → a plain close.
    this.send(socket, code ? { type: "error", message, code } : { type: "error", message });
    if (closeCode !== undefined) socket.close(closeCode, code);
    else socket.close();
  }

  /** The operator's minimum required agent version, read lazily from the env so it is testable and
   *  re-read per connection. Unset (the default) means the agent-version gate is off. */
  private minAgentVersion(): string | null {
    return process.env.HUB_MIN_AGENT_VERSION?.trim() || null;
  }

  /**
   * Apply the protocol/version compatibility gate. Returns true (and has already rejected + closed the
   * socket) when the agent is incompatible and must be turned away; false when it may proceed. A protocol
   * that is merely NEWER than the hub's is logged and ACCEPTED (never a hard reject), so a hub rollback
   * can't strand an agent that already self-updated. No DB write happens here: the socket is
   * unauthenticated at this point, so an unverified peer must not be able to stamp state onto a server row.
   */
  private rejectedForCompat(socket: WebSocket, protocol: unknown, agentVersion: unknown, where: string): boolean {
    const compat = checkAgentCompat({ protocol, agentVersion, minAgentVersion: this.minAgentVersion() });
    if (compat.ok) return false;
    if (compat.reason === "protocol_too_new") {
      this.logger.warn(`agent protocol ${String(protocol)} newer than hub ${PROTOCOL_VERSION} (${where}); accepting`);
      return false;
    }
    this.logger.warn(`rejecting incompatible agent (${compat.reason}) on ${where}: ${compat.detail}`);
    this.fail(socket, compat.detail, "agent_incompatible", 1008);
    return true;
  }

  get protocolVersion(): number {
    return PROTOCOL_VERSION;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.wss?.close();
  }
}

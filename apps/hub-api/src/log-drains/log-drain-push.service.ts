import { Injectable, Logger } from "@nestjs/common";
import { Prisma, type LogDrain } from "@prisma/client";
import {
  AGENT_FEATURE_DRAIN_FLUENTD,
  AGENT_FEATURE_DRAIN_GELF,
  AGENT_FEATURE_DRAIN_SYSLOG,
  AGENT_FEATURE_LOG_DRAINS_V2,
  DRAIN_ERR_CLASSES,
  DRAIN_STATES,
  type DrainErrClass,
} from "@tugra/shared";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { CryptoService } from "../crypto/crypto.service";
import { PrismaService } from "../prisma/prisma.service";
import { isHttpDrainType, isNetDrainType } from "./log-drain-shape";
import { resolveAppMatch, resolveServerMatch, type DrainMatch } from "./log-drain-match";

/** Delivery state of a drain as shown in the UI (worst-of over its target servers). */
export type DrainDelivery =
  | "disabled"
  | "offline"
  | "agent_outdated"
  | "capability_revoked"
  | "pending"
  | "ok"
  | "error"
  | "invalid";

export interface DrainStatusView {
  sent: number;
  dropped: number;
  errClass?: DrainErrClass;
  lastOkAt?: string;
}

/** What the last push did with one drain on one server. */
type PushOutcome = "sent" | "agent_outdated" | "capability_revoked" | "invalid";

interface StatusRecord {
  state: "ok" | "error" | "idle" | "invalid";
  errClass?: DrainErrClass;
  sent: number;
  dropped: number;
  lastOkAt?: number;
  receivedAt: number;
}

/** Entries older than this read as "pending" (the agent reports every 30 s). */
const STATUS_STALE_MS = 120_000;
const MAX_STATUS_ENTRIES = 200;
const MAX_DRAIN_ID_LEN = 40;

const RANK: Record<DrainDelivery, number> = {
  invalid: 7,
  error: 6,
  agent_outdated: 5,
  capability_revoked: 4,
  offline: 3,
  pending: 2,
  ok: 1,
  disabled: 0,
};

const NET_FEATURE: Record<string, string> = {
  syslog: AGENT_FEATURE_DRAIN_SYSLOG,
  gelf: AGENT_FEATURE_DRAIN_GELF,
  fluentd: AGENT_FEATURE_DRAIN_FLUENTD,
};

/** Wire shape of one drain inside a `log_drains_v2` frame. Keys are omitted when default, never null. */
interface WireDrain {
  id: string;
  type: string;
  endpoint: string;
  token: string;
  scope?: "app";
  appId?: string;
  match?: DrainMatch;
  host: string;
  options?: Record<string, unknown>;
  egress?: "public" | "any";
}

type AppRef = { id: string; serverId: string; clusterId: string | null };

/** The server name as a syslog/GELF host label: [A-Za-z0-9._-]{1,64}, falling back to the server id. */
export function sanitizeHost(name: string | null | undefined, fallback: string): string {
  const s = (name ?? "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return s || fallback;
}

/**
 * Builds and pushes each server's log-drain set to its agent, and tracks per-drain delivery. A leaf service:
 * it depends only on Prisma, Crypto and the agent gateway, so the app/cluster/server-ops modules can all use it
 * without a DI cycle.
 */
@Injectable()
export class LogDrainPushService {
  private readonly logger = new Logger(LogDrainPushService.name);
  private lastRev = 0;
  /** drain ids included in the last v2 frame per server: drain_status is accepted ONLY for these. */
  private readonly pushedIds = new Map<string, Set<string>>();
  /** what the last push did with each drain on each server. */
  private readonly outcomes = new Map<string, Map<string, PushOutcome>>();
  private readonly statuses = new Map<string, Map<string, StatusRecord>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly agentWs: AgentWsServer,
  ) {}

  /** Monotonic per process, and clock-based so it also increases across hub restarts. */
  private nextRev(): number {
    this.lastRev = Math.max(this.lastRev + 1, Date.now());
    return this.lastRev;
  }

  private safeDecrypt(enc: string): string {
    try {
      return this.crypto.decrypt(enc);
    } catch {
      return "";
    }
  }

  /** Per-server push serialization: while a push runs, further requests only mark it dirty and join it. */
  private readonly pushing = new Map<string, { running: Promise<void>; dirty: boolean }>();

  /**
   * Push the server's full effective drain set (server-wide + app drains targeting it) to its agent. Pushes for one
   * server never overlap: a request that arrives mid-push coalesces into ONE follow-up push that re-reads the rows,
   * so the rows are always read after the mutation that asked for them and the rev (taken at send time, after the
   * reads) grows in read order. Without this an older snapshot could be signed last, take the higher rev and win
   * over the newer one, which the agent would reject as stale.
   */
  pushToAgent(serverId: string): Promise<void> {
    const cur = this.pushing.get(serverId);
    if (cur) {
      cur.dirty = true;
      return cur.running;
    }
    const entry = { running: Promise.resolve(), dirty: false };
    entry.running = (async () => {
      try {
        do {
          entry.dirty = false;
          await this.doPush(serverId);
        } while (entry.dirty);
      } finally {
        this.pushing.delete(serverId);
      }
    })();
    this.pushing.set(serverId, entry);
    return entry.running;
  }

  private async doPush(serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { name: true, clusterId: true } });
    if (!server) return;
    const where: Prisma.LogDrainWhereInput = {
      enabled: true,
      OR: [
        { serverId, appId: null },
        { appId: { not: null }, app: { serverId, clusterId: null } },
        ...(server.clusterId ? [{ appId: { not: null }, app: { clusterId: server.clusterId } }] : []),
      ],
    };
    const rows = await this.prisma.logDrain.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const outcomes = new Map<string, PushOutcome>();
    this.outcomes.set(serverId, outcomes);

    // Decrypt. Legacy plain server-wide http rows keep the old behaviour (a decrypt failure -> ""); app-scoped
    // and NET rows FAIL CLOSED (a drain whose credential cannot be read is skipped, never sent without it).
    const decrypted = new Map<string, string>();
    const usable: LogDrain[] = [];
    for (const d of rows) {
      const legacyRow = d.appId === null && isHttpDrainType(d.type);
      if (!d.authTokenEnc) {
        decrypted.set(d.id, "");
        usable.push(d);
        continue;
      }
      if (legacyRow) {
        decrypted.set(d.id, this.safeDecrypt(d.authTokenEnc));
        usable.push(d);
        continue;
      }
      let token: string | null = null;
      try {
        token = this.crypto.decrypt(d.authTokenEnc);
      } catch {
        token = null;
      }
      if (token === null) {
        this.logger.warn(`log drain ${d.id}: token cannot be decrypted; skipping it`);
        outcomes.set(d.id, "invalid");
        continue;
      }
      decrypted.set(d.id, token);
      usable.push(d);
    }

    const v2 = this.agentWs.agentSupports(serverId, AGENT_FEATURE_LOG_DRAINS_V2);
    if (!v2) {
      // LEGACY path (old agent, or offline): ONLY plain server-wide http/loki/datadog drains, in exactly the
      // pre-D7 frame. Everything else is WITHHELD: an old agent ignores unknown JSON keys and would otherwise
      // ship every tugra_ container (other apps, databases) to a per-app sink.
      const drains: { id: string; type: string; endpoint: string; token: string }[] = [];
      for (const d of usable) {
        const plain = d.appId === null && isHttpDrainType(d.type) && d.containers.length === 0 && d.options == null;
        if (plain) {
          drains.push({ id: d.id, type: d.type, endpoint: d.endpoint, token: decrypted.get(d.id) ?? "" });
          outcomes.set(d.id, "sent");
        } else {
          outcomes.set(d.id, "agent_outdated");
        }
      }
      this.pushedIds.set(serverId, new Set());
      this.agentWs.sendToAgent(serverId, { type: "log_drains", drains });
      return;
    }

    const eligible: LogDrain[] = [];
    for (const d of usable) {
      const feature = NET_FEATURE[d.type.toLowerCase()];
      if (feature && !this.agentWs.agentSupports(serverId, feature)) outcomes.set(d.id, "agent_outdated");
      else eligible.push(d);
    }
    // `logs` revoked: send NOTHING (the agent would reject a v2 frame). The agent clears its own v2 sinks when
    // the capabilities message drops `logs`; the hub re-pushes after every capability change so a re-grant restores.
    if (!(await this.agentWs.isCapabilityGranted(serverId, "logs"))) {
      for (const d of eligible) outcomes.set(d.id, "capability_revoked");
      this.pushedIds.set(serverId, new Set());
      return;
    }
    const host = sanitizeHost(server.name, serverId);
    const wire = eligible.map((d) => this.toWire(d, decrypted.get(d.id) ?? "", host));
    for (const d of eligible) outcomes.set(d.id, "sent");
    this.pushedIds.set(serverId, new Set(wire.map((w) => w.id)));
    const drainsJson = JSON.stringify(wire);
    this.agentWs.sendToAgent(serverId, {
      type: "log_drains_v2",
      serverId,
      rev: this.nextRev(),
      capability: "logs",
      drainsJson,
    });
  }

  /** Key order is fixed (id, type, endpoint, token, scope, appId, match, host, options, egress) and default keys
   *  are omitted, so the signed JSON string is deterministic. */
  private toWire(d: LogDrain, token: string, host: string): WireDrain {
    const w: Record<string, unknown> = { id: d.id, type: d.type, endpoint: d.endpoint, token };
    if (d.appId) {
      w.scope = "app";
      w.appId = d.appId;
      w.match = resolveAppMatch(d.appId, d.containers);
    } else {
      const m = resolveServerMatch(d.containers);
      if (m) w.match = m;
    }
    w.host = host;
    if (d.options && typeof d.options === "object") w.options = d.options;
    if (d.appId) w.egress = d.allowPrivate ? "any" : "public";
    else if (isNetDrainType(d.type.toLowerCase())) w.egress = "any"; // unguarded http stays omitted, as today
    return w as unknown as WireDrain;
  }

  /** Servers an app's drains must reach: every cluster member of a swarm app (plus the anchor), else the app's server. */
  async targetServerIds(app: AppRef): Promise<string[]> {
    const ids = new Set<string>([app.serverId]);
    if (app.clusterId) {
      const members = await this.prisma.server.findMany({ where: { clusterId: app.clusterId }, select: { id: true } });
      for (const m of members) ids.add(m.id);
    }
    return [...ids];
  }

  /** Re-push to a set of servers. Fire-and-forget safe: one failing server never blocks the others. */
  async pushForServers(ids: string[]): Promise<void> {
    await Promise.all(
      [...new Set(ids)].map((id) =>
        this.pushToAgent(id).catch((e: unknown) => this.logger.warn(`log drain push to ${id} failed: ${e instanceof Error ? e.message : String(e)}`)),
      ),
    );
  }

  async pushForApp(app: AppRef): Promise<void> {
    await this.pushForServers(await this.targetServerIds(app));
  }

  async pushForCluster(clusterId: string): Promise<void> {
    const members = await this.prisma.server.findMany({ where: { clusterId }, select: { id: true } });
    await this.pushForServers(members.map((m) => m.id));
  }

  // ---- status (in-memory, S5) ----

  /** Accept an agent's drain_status for `serverId` (taken from the authed socket, never the body). Only ids this
   *  hub pushed to that server are kept; every value is validated against its enum / clamped. */
  ingestStatus(serverId: string, raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const pushed = this.pushedIds.get(serverId);
    if (!pushed || pushed.size === 0) return;
    const next = new Map<string, StatusRecord>();
    const now = Date.now();
    for (const e of raw.slice(0, MAX_STATUS_ENTRIES)) {
      if (!e || typeof e !== "object") continue;
      const r = e as Record<string, unknown>;
      const id = typeof r.id === "string" ? r.id : "";
      if (!id || id.length > MAX_DRAIN_ID_LEN || !pushed.has(id)) continue;
      const state = r.state;
      if (typeof state !== "string" || !(DRAIN_STATES as readonly string[]).includes(state)) continue;
      const rec: StatusRecord = {
        state: state as StatusRecord["state"],
        sent: clampCount(r.sent),
        dropped: clampCount(r.dropped),
        receivedAt: now,
      };
      if (typeof r.errClass === "string" && (DRAIN_ERR_CLASSES as readonly string[]).includes(r.errClass)) rec.errClass = r.errClass as DrainErrClass;
      if (typeof r.lastOkAt === "number" && Number.isFinite(r.lastOkAt) && r.lastOkAt > 0) rec.lastOkAt = Math.floor(r.lastOkAt);
      next.set(id, rec);
    }
    this.statuses.set(serverId, next);
  }

  private stateOn(serverId: string, drain: { id: string }): { delivery: DrainDelivery; rec?: StatusRecord } {
    if (!this.agentWs.isOnline(serverId)) return { delivery: "offline" };
    const outcome = this.outcomes.get(serverId)?.get(drain.id);
    if (!outcome) return { delivery: "pending" };
    if (outcome !== "sent") return { delivery: outcome };
    const rec = this.statuses.get(serverId)?.get(drain.id);
    if (!rec || Date.now() - rec.receivedAt > STATUS_STALE_MS) return { delivery: "pending" };
    if (rec.state === "error") return { delivery: "error", rec };
    if (rec.state === "invalid") return { delivery: "invalid", rec };
    if (rec.state === "ok") return { delivery: "ok", rec };
    return { delivery: "pending", rec }; // idle: configured, nothing delivered yet
  }

  /** Delivery + aggregated status of one drain over its target servers (worst-of; `disabled` first). */
  deliveryFor(drain: { id: string; enabled: boolean }, targets: string[]): { delivery: DrainDelivery; status: DrainStatusView | null } {
    if (!drain.enabled) return { delivery: "disabled", status: null };
    let worst: DrainDelivery = "ok";
    let first = true;
    let sent = 0;
    let dropped = 0;
    let errClass: DrainErrClass | undefined;
    let lastOk = 0;
    let any = false;
    for (const t of targets) {
      const { delivery, rec } = this.stateOn(t, drain);
      if (first || RANK[delivery] > RANK[worst]) worst = delivery;
      first = false;
      if (rec) {
        any = true;
        sent += rec.sent;
        dropped += rec.dropped;
        if (rec.errClass && !errClass) errClass = rec.errClass;
        if (rec.lastOkAt && rec.lastOkAt > lastOk) lastOk = rec.lastOkAt;
      }
    }
    if (first) worst = "offline";
    const status: DrainStatusView | null = any
      ? { sent, dropped, ...(errClass ? { errClass } : {}), ...(lastOk ? { lastOkAt: new Date(lastOk).toISOString() } : {}) }
      : null;
    return { delivery: worst, status };
  }
}

function clampCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

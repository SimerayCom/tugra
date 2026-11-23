import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isIPv4 } from "node:net";
import { Prisma } from "@prisma/client";
import { AGENT_FEATURE_HUB_ENDPOINTS, type HubEndpoint, type HubEndpointStateMsg } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import {
  RevClock,
  domainEndpoint,
  graceActive,
  hostOfEndpoint,
  ipEndpoint,
  newGrace,
  normalizeEndpoints,
  parseGrace,
  serializeEndpoints,
  summarizeMove,
  type AgentEndpointGrace,
  type AgentMoveRow,
} from "../agent-gateway/hub-endpoints";
import { certFingerprint, certSpkiPin, generateSelfSignedCert } from "../common/self-signed-cert";
import { hubBaseUrl } from "../common/hub-url";
import { ProxyService } from "./proxy.service";

/** Where the panel is moving to. */
export type MoveTarget = { kind: "domain"; domain: string } | { kind: "ip"; ip: string };

export interface AgentMoveStatus {
  /** The address agents are moving to (wss URL). */
  primaryUrl: string;
  total: number;
  moved: number;
  pending: AgentMoveRow[];
  /** When the old address stops being routed for the agent path regardless (ISO). */
  expiresAt: string;
  /** The panel itself has not switched yet (the change is still running). */
  switching: boolean;
}

export interface IpTransport {
  ip: string;
  /** wss://<ip>/agent — what the agent dials. */
  hubUrl: string;
  /** sha256:<hex> of the certificate (the agent's --hub-pin). */
  pin: string;
  /** base64 sha256 of the SPKI (curl --pinnedpubkey) for fetching the installer itself over the pinned certificate. */
  spkiPin: string;
  /** https://<ip> — the origin the installer is fetched from. */
  origin: string;
}

/**
 * The hub side of the agents' endpoint list (hub_endpoints_v1) and of the IP-mode transport.
 *
 *  - Computes the ordered list agents may dial (current address first, then — during a grace — the previous ones),
 *    signs it (AgentWsServer.signOutbound, hub key, the server id inside the signature) and pushes it on every connect and
 *    whenever it changes.
 *  - Stores what each agent reports (`hub_endpoint_state`): the endpoint its session is on and whether it accepted the list.
 *  - Drives the GRACE of an address move: before the panel switches, the new list goes to every connected agent; the old
 *    host / the IP route stay routable for the agent path (ProxyConfigService renders them from the persisted grace) until
 *    every agent reports the new address, the owner confirms, or 7 days pass.
 *  - Owns the IP-mode self-signed certificate: generated once, persisted (key encrypted), its fingerprint is what an
 *    agent pins. It is never rotated implicitly: a changed certificate could only reach agents through a signed list.
 */
@Injectable()
export class AgentEndpointsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AgentEndpointsService.name);
  private readonly clock = new RevClock();
  private sweepTimer?: ReturnType<typeof setInterval>;
  /** Timings (ms); tests shrink them. */
  timing = { sweep: 60_000, moveWait: 30_000, movePoll: 1_000, switchStale: 60 * 60_000 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: InstanceSettingsService,
    private readonly crypto: CryptoService,
    private readonly agentWs: AgentWsServer,
    private readonly proxy: ProxyService,
  ) {}

  onApplicationBootstrap(): void {
    this.agentWs.setHubEndpointsHooks({
      onConnect: (serverId) => void this.onConnect(serverId).catch((e) => this.logger.warn(`endpoints on connect: ${(e as Error).message}`)),
      onState: (serverId, msg) => void this.onState(serverId, msg).catch((e) => this.logger.warn(`endpoint state: ${(e as Error).message}`)),
    });
    this.sweepTimer = setInterval(() => void this.sweep().catch((e) => this.logger.warn(`endpoint sweep: ${(e as Error).message}`)), this.timing.sweep);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // ---------------------------------------------------------------- the IP-mode certificate

  /** The IPv4 the hub is reached on in IP mode (PANEL_IP_ROUTE=1 and a bare-IP public URL, no port), else null. */
  ipModeAddress(): string | null {
    if (this.config.get<string>("PANEL_IP_ROUTE")?.trim() !== "1") return null;
    const base = this.publicBase();
    if (!base) return null;
    return isIPv4(base.hostname) && base.port === "" ? base.hostname : null;
  }

  private publicBase(publicUrl?: string): URL | null {
    try {
      return new URL(hubBaseUrl(publicUrl ?? (this.config.get<string>("WEB_PUBLIC_URL") || undefined)));
    } catch {
      return null;
    }
  }

  /** The persisted certificate + key, generated (once, race-safe) if this is the first use. `ip` = the SAN to embed. */
  async ensureIpTls(ip?: string | null): Promise<{ certPem: string; keyPem: string; fingerprint: string }> {
    const read = async () => {
      const s = await this.settings.get();
      if (s.ipTlsCertPem && s.ipTlsKeyEnc) return { certPem: s.ipTlsCertPem, keyPem: this.crypto.decrypt(s.ipTlsKeyEnc), fingerprint: certFingerprint(s.ipTlsCertPem) };
      return null;
    };
    const have = await read();
    if (have) return have;
    const gen = generateSelfSignedCert({ ip: ip ?? this.ipModeAddress() ?? undefined });
    // Conditional write: two concurrent first uses must end up with ONE certificate (the loser re-reads the winner's).
    await this.prisma.instanceSettings.updateMany({
      where: { id: "singleton", ipTlsCertPem: null },
      data: { ipTlsCertPem: gen.certPem, ipTlsKeyEnc: this.crypto.encrypt(gen.keyPem) },
    });
    const now = await read();
    if (!now) throw new Error("could not persist the IP-mode certificate");
    return now;
  }

  /** Make the local proxy serve the host-less routes on :443 (cert written, router rendered) and remember that it did. */
  async syncIpTls(): Promise<void> {
    const local = await this.prisma.server.findFirst({ where: { isLocal: true }, select: { id: true, proxyBind: true } });
    if (!local) return;
    const g = parseGrace((await this.settings.get()).agentEndpointGrace);
    const needed = this.ipModeAddress() !== null || (graceActive(g, Date.now()) && [...g.fallbacks, g.primary].some((e) => isIPv4(new URL(e.url).hostname)));
    if (!needed) return;
    const m = await this.ensureIpTls();
    await this.proxy.ensureProxy(local.id);
    // :443 reachable from outside only when the proxy publishes on all interfaces.
    if (local.proxyBind === "public" || !local.proxyBind) await this.settings.update({ ipTlsServedFp: m.fingerprint });
  }

  /** The IP endpoint (pinned) agents should use, only when the proxy has actually been configured to serve it. */
  async ipTransport(): Promise<IpTransport | null> {
    const ip = this.ipModeAddress();
    if (!ip) return null;
    const s = await this.settings.get();
    if (!s.ipTlsCertPem) return null;
    const fingerprint = certFingerprint(s.ipTlsCertPem);
    if (s.ipTlsServedFp !== fingerprint) return null; // not (yet) served: keep the plain path rather than hand out a dead address
    return { ip, hubUrl: `wss://${ip}/agent`, pin: fingerprint, spkiPin: certSpkiPin(s.ipTlsCertPem), origin: `https://${ip}` };
  }

  /**
   * The transport for an add-server command: IP mode with the pinned certificate when it is up, else null (the caller
   * falls back to the existing URL derivation: wss for a domain, plain ws:// otherwise, which the caller marks explicitly insecure).
   */
  async installTransport(publicUrl?: string): Promise<IpTransport | null> {
    const t = await this.ipTransport();
    if (!t) return null;
    const base = this.publicBase(publicUrl);
    return base && base.hostname === new URL(t.origin).hostname ? t : null; // the request must be for the IP we serve
  }

  // ---------------------------------------------------------------- the list

  /** The list agents should hold right now, or null when this instance has no address worth pushing (port mode / http domain). */
  async currentList(): Promise<HubEndpoint[] | null> {
    const s = await this.settings.get();
    const g = parseGrace(s.agentEndpointGrace);
    if (graceActive(g, Date.now())) return normalizeEndpoints([g.primary, ...g.fallbacks]);
    const ip = await this.ipTransport();
    if (ip) return [ipEndpoint(ip.ip, ip.pin)];
    const base = this.publicBase();
    if (base && base.protocol === "https:" && base.hostname && !isIPv4(base.hostname) && !base.hostname.includes(":") && base.port === "") {
      return [domainEndpoint(base.hostname)];
    }
    return null;
  }

  async currentPrimaryUrl(): Promise<string | null> {
    return (await this.currentList())?.[0]?.url ?? null;
  }

  /** Servers that count towards "moved": every enrolled, non-local server (the box the hub runs on dials the internal address). */
  private async remoteServers() {
    return this.prisma.server.findMany({
      where: { isLocal: false, status: { not: "PENDING" } },
      select: { id: true, name: true, status: true, hubEndpointActive: true, hubEndpointError: true },
      orderBy: { name: "asc" },
    });
  }

  /** Sign + send `list` to one connected agent that understands it. False when skipped (offline / old agent). */
  async pushList(serverId: string, list: HubEndpoint[]): Promise<boolean> {
    if (!this.agentWs.agentSupports(serverId, AGENT_FEATURE_HUB_ENDPOINTS)) return false;
    const rev = this.clock.next();
    return this.agentWs.sendToAgent(serverId, { type: "hub_endpoints", serverId, rev, endpointsJson: serializeEndpoints(list) });
  }

  /** Push the current list to one server (no-op for the local server, an old agent, or an instance with nothing to push). */
  async pushTo(serverId: string): Promise<boolean> {
    const row = await this.prisma.server.findUnique({ where: { id: serverId }, select: { isLocal: true } });
    if (!row || row.isLocal) return false;
    const list = await this.currentList();
    return list ? this.pushList(serverId, list) : false;
  }

  /** Push the current list to every connected remote agent; resolves with how many were sent one. */
  async pushAll(): Promise<number> {
    const list = await this.currentList();
    if (!list) return 0;
    let n = 0;
    for (const s of await this.remoteServers()) if (this.agentWs.isOnline(s.id) && (await this.pushList(s.id, list))) n++;
    return n;
  }

  private async onConnect(serverId: string): Promise<void> {
    const row = await this.prisma.server.findUnique({ where: { id: serverId }, select: { isLocal: true } });
    if (row?.isLocal) {
      await this.syncIpTls().catch((e) => this.logger.warn(`ip tls: ${(e as Error).message}`));
      return;
    }
    await this.pushTo(serverId);
  }

  /** An agent's report: the endpoint its session is on and whether it accepted the list. */
  async onState(serverId: string, msg: HubEndpointStateMsg): Promise<void> {
    const str = (v: unknown, n = 300) => (typeof v === "string" ? v.slice(0, n) : null);
    const rev = typeof msg.rev === "number" && Number.isFinite(msg.rev) && msg.rev >= 0 ? BigInt(Math.trunc(msg.rev)) : null;
    await this.prisma.server.update({
      where: { id: serverId },
      data: {
        hubEndpointActive: str(msg.active),
        hubEndpointPrimary: str(msg.primary),
        hubEndpointRev: rev,
        hubEndpointError: msg.accepted === false ? (str(msg.error, 200) ?? "refused") : null,
        hubEndpointAt: new Date(),
      },
    });
    // An agent refused a list as older than the one it holds, and that rev is above anything this hub process knows
    // (the clock jumped forward once, or the hub was restored on a host whose clock is behind): raise the counter past
    // it and send the list again, so a later domain change can still reach the agent. Bounded: after the raise the
    // next rev is above the agent's, and a second refusal reports a rev no higher than the counter.
    if (msg.accepted === false && typeof msg.rev === "number" && this.clock.observe(msg.rev)) await this.pushTo(serverId);
    await this.sweep();
  }

  // ---------------------------------------------------------------- the move (grace)

  /** The list a move to `target` leaves agents with: the new address first, every current address behind it. */
  async planMove(target: MoveTarget): Promise<{ primary: HubEndpoint; fallbacks: HubEndpoint[] }> {
    let primary: HubEndpoint;
    if (target.kind === "domain") primary = domainEndpoint(target.domain);
    else {
      const m = await this.ensureIpTls(target.ip);
      primary = ipEndpoint(target.ip, m.fingerprint);
    }
    const current = (await this.currentList()) ?? [];
    const fallbacks = current.filter((e) => e.url !== primary.url);
    // IP mode: the IP route is ALWAYS kept as a fallback, whether or not its TLS has been confirmed "served"
    // (currentList only lists it once ipTlsServedFp matches, which stays null with a loopback-bound proxy, a failed
    // ensureProxy, or a local agent that has not reconnected since the upgrade). Without it the grace would carry no
    // IP route and the switch would strand every agent that did not take the list — they all dial the IP.
    const ip = this.ipModeAddress();
    if (ip && !fallbacks.some((e) => e.url !== primary.url && hostOfEndpoint(e) === ip) && hostOfEndpoint(primary) !== ip) {
      const m = await this.ensureIpTls(ip);
      fallbacks.push(ipEndpoint(ip, m.fingerprint));
    }
    return { primary, fallbacks };
  }

  /**
   * Start moving the agents: persist the grace (so the proxy keeps the old host / IP routable for /agent whatever happens
   * to the panel), push the new list to every connected agent, and give them a short window to report the new endpoint.
   * Never blocks the change on a straggler — the grace is what protects it. No remote servers = nothing to do.
   */
  async beginMove(plan: { primary: HubEndpoint; fallbacks: HubEndpoint[] }): Promise<{ total: number; moved: number }> {
    const remote = await this.remoteServers();
    if (remote.length === 0) return { total: 0, moved: 0 };
    // An earlier change whose grace is still open (a straggler has not moved) must survive this one failing early.
    const earlier = parseGrace((await this.settings.get()).agentEndpointGrace);
    const now = Date.now();
    let previous: AgentEndpointGrace | undefined;
    if (earlier && graceActive(earlier, now) && !earlier.pendingSwitch) {
      const { previous: _p, ...rest } = earlier;
      previous = rest;
    } else if (earlier?.previous && graceActive(earlier.previous, now)) previous = earlier.previous; // a stale pending job: keep what it was protecting
    const grace: AgentEndpointGrace = { ...newGrace(plan.primary, plan.fallbacks, now), pendingSwitch: true, ...(previous ? { previous } : {}) };
    await this.settings.update({ agentEndpointGrace: grace as unknown as object });
    await this.proxy.ensureProxy((await this.localId()) as string).catch((e) => this.logger.warn(`grace routes: ${(e as Error).message}`));
    await this.pushAll();
    return this.waitForMoves(plan.primary.url);
  }

  private async localId(): Promise<string | null> {
    return (await this.prisma.server.findFirst({ where: { isLocal: true }, select: { id: true } }))?.id ?? null;
  }

  private async waitForMoves(primaryUrl: string): Promise<{ total: number; moved: number }> {
    const deadline = Date.now() + this.timing.moveWait;
    for (;;) {
      const sum = await this.progressFor(primaryUrl);
      // Offline / old agents cannot answer: waiting for them would only stall the change.
      const waiting = sum.pending.filter((p) => p.reason === "waiting").length;
      if (waiting === 0 || Date.now() >= deadline) return { total: sum.total, moved: sum.moved };
      await new Promise((r) => setTimeout(r, this.timing.movePoll));
    }
  }

  /** The panel now lives at the new address: from here the grace may end as soon as every agent has moved. */
  async markSwitched(): Promise<void> {
    const g = parseGrace((await this.settings.get()).agentEndpointGrace);
    if (!g) return;
    const { pendingSwitch: _ps, ...rest } = g;
    await this.settings.update({ agentEndpointGrace: rest as unknown as object });
    await this.pushAll(); // the new hub process re-asserts the list (agents also get it on every connect)
  }

  /** The change failed before the switch: forget the grace and point every agent back at the address that still works. */
  async cancelMove(): Promise<void> {
    const g = parseGrace((await this.settings.get()).agentEndpointGrace);
    // Only the grace THIS change opened (still waiting for the switch): a failure that came before moveAgents, or an
    // earlier change's post-switch grace, is not ours to delete.
    if (!g || !g.pendingSwitch) return;
    const back = g.previous && graceActive(g.previous, Date.now()) ? g.previous : null;
    await this.settings.update({ agentEndpointGrace: back ? (back as unknown as object) : Prisma.DbNull });
    await this.pushAll(); // the steady list (the CURRENT address, plus any earlier grace) — agents that went to the new one come back
    // (the caller re-renders the proxy afterwards)
  }

  /** Owner: "stop waiting for the rest" — drop the old routes now. */
  async release(): Promise<void> {
    const g = parseGrace((await this.settings.get()).agentEndpointGrace);
    if (!g) return;
    await this.endGrace("confirmed by the owner");
  }

  private async endGrace(why: string): Promise<void> {
    this.logger.log(`agent address grace ended: ${why}`);
    await this.recordStragglers(why);
    await this.settings.update({ agentEndpointGrace: Prisma.DbNull });
    await this.pushAll(); // the list without the old addresses
    const id = await this.localId();
    if (id) await this.proxy.ensureProxy(id).catch((e) => this.logger.warn(`grace routes drop: ${(e as Error).message}`));
  }

  /**
   * The grace is a bounded promise (7 days), not a guarantee: an agent that never reported the new address (too old to
   * understand the list, or offline the whole window) loses its old route when the grace ends and needs a re-install.
   * The "did not move" list is only shown while the grace lasts, so write it down — log + audit — before it goes away.
   */
  private async recordStragglers(why: string): Promise<void> {
    try {
      const g = parseGrace((await this.settings.get()).agentEndpointGrace);
      if (!g) return;
      const left = (await this.progressFor(g.primary.url)).pending;
      if (left.length === 0) return;
      const names = left.map((p) => `${p.name} (${p.reason})`);
      this.logger.warn(`agent address grace ended (${why}) with ${left.length} agent(s) still on the old address — they must be re-installed against ${g.primary.url}: ${names.join(", ")}`);
      await this.prisma.auditLog?.create({ data: { actor: "system", action: "instance.panel_domain.agents_left_behind", target: g.primary.url, meta: { why, servers: left.slice(0, 50).map((p) => ({ id: p.id, name: p.name, reason: p.reason })) } } });
    } catch (e) {
      this.logger.warn(`straggler record: ${(e as Error).message}`);
    }
  }

  /** Ends a grace that is done (everyone moved), expired, or abandoned. Safe to call often. */
  async sweep(): Promise<void> {
    const g = parseGrace((await this.settings.get()).agentEndpointGrace);
    if (!g) return;
    const now = Date.now();
    if (g.pendingSwitch) {
      if (now - g.startedAt > this.timing.switchStale) await this.endGrace("the panel change never finished");
      return; // the hub's own address is still the old one: never end (or re-point agents) mid-change
    }
    const expired = now >= g.expiresAt;
    if (!graceActive(g, now)) return this.endGrace(expired ? "expired" : "confirmed");
    const sum = await this.progressFor(g.primary.url);
    if (sum.moved === sum.total) await this.endGrace("every agent reports the new address");
  }

  private async progressFor(primaryUrl: string) {
    const rows = await this.remoteServers();
    return summarizeMove(
      primaryUrl,
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        online: this.agentWs.isOnline(r.id),
        supported: this.agentWs.agentSupports(r.id, AGENT_FEATURE_HUB_ENDPOINTS),
        active: r.hubEndpointActive,
        error: r.hubEndpointError,
      })),
    );
  }

  /** For Settings → Panel domain: how far the agents are, or null when no move is being waited on. */
  async status(): Promise<AgentMoveStatus | null> {
    const g = parseGrace((await this.settings.get()).agentEndpointGrace);
    if (!graceActive(g, Date.now())) return null;
    const sum = await this.progressFor(g.primary.url);
    return { primaryUrl: g.primary.url, total: sum.total, moved: sum.moved, pending: sum.pending, expiresAt: new Date(g.expiresAt).toISOString(), switching: g.pendingSwitch === true };
  }
}

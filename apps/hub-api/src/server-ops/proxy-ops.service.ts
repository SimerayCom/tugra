import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { parse as parseYaml } from "yaml";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ProxyConfigService } from "../proxy-config/proxy-config.service";
import { SwarmProxyService } from "../clusters/swarm-proxy.service";
import {
  buildProxyDynamicRemoveScript,
  buildProxyDynamicWriteScript,
  buildProxyLogsScript,
  buildProxyRestartScript,
  buildProxySetupScript,
  buildProxyAccessLogCleanupScript,
  buildProxyStatusScript,
  buildProxyStopScript,
} from "../deploy/deploy-script";
import { PROXY_DYNAMIC_NAME_RE } from "./dto";

const MAX_DYNAMIC_CONFIGS = 25;

const PROXY_TIMEOUT_MS = 60_000;

export type ProxyStatus = "running" | "stopped" | "absent";

/** How a Traffic Analytics toggle reached the proxy: applied now, deferred (no running proxy / no ingress yet —
 *  the flag is honored when it is next created), failed (the flag IS saved; retry the same call or Start the
 *  proxy), not-in-pool (swarm: the server is not an ingress-pool manager, so its flag has no effect until it
 *  joins the pool), or cluster-shared (swarm: the ingress is one service and logs when ANY pool node has the
 *  flag, so the effective cluster-wide state differs from the requested one). */
export type TrafficAnalyticsApply = "applied" | "deferred" | "failed" | "not-in-pool" | "cluster-shared";
export interface TrafficAnalyticsState {
  trafficAnalytics: boolean;
  apply: TrafficAnalyticsApply;
  applyError: string | null;
}

function parseStatus(raw: string): ProxyStatus {
  const s = raw.trim().toLowerCase();
  if (s === "running") return "running";
  if (s === "" || s === "absent" || s.includes("no such")) return "absent";
  return "stopped"; // exited | created | paused | restarting | dead
}

/** Manage the Traefik reverse-proxy on a server (Coolify "Proxy" parity). */
@Injectable()
export class ProxyOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly proxyConfig: ProxyConfigService,
    private readonly swarmProxy: SwarmProxyService,
  ) {}

  async status(userId: string, serverId: string): Promise<{ status: ProxyStatus }> {
    await this.requireRead(userId, serverId);
    const r = await this.agentWs.sendCommand(serverId, buildProxyStatusScript(), "deploy", PROXY_TIMEOUT_MS);
    return { status: parseStatus(r.output) };
  }

  async start(userId: string, serverId: string): Promise<{ status: ProxyStatus }> {
    await this.requireWrite(userId, serverId);
    await this.recreateClassic(serverId);
    await this.audit.log({ actor: userId, action: "server.proxy.start", target: serverId });
    return this.statusAfter(serverId);
  }

  /** Recreate the classic per-server Traefik from the resolved config. Single source of truth
   *  (ProxyConfigService) — SAME resolver as ProxyService.ensureProxy, so `start` and a domained deploy produce
   *  an identical proxy (email, bind mode, DNS-01 creds, access log, and — on the local server — the panel
   *  router). It recreates the container, so the bind mode / access log are (re)applied here too. */
  private async recreateClassic(serverId: string): Promise<void> {
    const cfg = await this.proxyConfig.resolveFor(serverId);
    const r = await this.agentWs.sendCommand(
      serverId,
      buildProxySetupScript({
        acmeEmail: cfg.acmeEmail,
        bind: cfg.bind,
        dnsProvider: cfg.dnsProvider,
        dnsCreds: cfg.dnsCreds,
        panel: cfg.panel,
        accessLog: cfg.accessLog,
      }),
      "deploy",
      PROXY_TIMEOUT_MS,
    );
    // The script removes the old container before `docker run`; a non-zero exit means the proxy is now
    // gone/broken. Fail loudly (and skip the success audit + status probe) rather than reporting success.
    if (r.exitCode !== 0) {
      throw new BadRequestException(`reverse-proxy (Traefik) start failed: ${r.output.trim().slice(-500)}`);
    }
  }

  /**
   * Turn Traffic Analytics (the proxy access log) on/off for a server. Same gate as the other server-settings
   * mutations (servers:manage). The flag write is authoritative and happens FIRST; the proxy is then re-applied
   * so the change takes effect now — the classic Traefik is recreated, a swarm member's cluster ingress is
   * ensured (its confighash folds the flag in, so the service is recreated). When there is no proxy yet the
   * flag simply applies when it is first created ("deferred"). A re-apply failure never rolls the flag back and
   * never passes silently: it is returned as apply="failed" + applyError and recorded in the audit entry.
   */
  async setTrafficAnalytics(userId: string, serverId: string, enabled: boolean): Promise<TrafficAnalyticsState> {
    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
      select: { id: true, teamId: true, clusterId: true, swarmNodeId: true, cluster: { select: { swarmStatus: true } } },
    });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");

    await this.prisma.server.update({ where: { id: serverId }, data: { trafficAnalytics: enabled } });

    let apply: TrafficAnalyticsApply = "applied";
    let applyError: string | null = null;
    try {
      const swarmStatus = server.cluster?.swarmStatus;
      const inSwarm = !!server.clusterId && !!server.swarmNodeId && !!swarmStatus && swarmStatus !== "NONE";
      if (inSwarm) {
        // Swarm ingress: only re-ensure when the cluster ingress already exists (ensure() would otherwise
        // create it as a side effect of a settings toggle). ensure() recomputes the confighash → recreates.
        if (swarmStatus !== "ACTIVE" && swarmStatus !== "DEGRADED") {
          apply = "deferred";
        } else {
          const cur = await this.swarmProxy.status(server.clusterId!);
          if (!(cur.exitCode === 0 && cur.output.trim())) {
            apply = "deferred";
          } else {
            // ONE ingress service for the whole pool: the flag only matters for pool managers, and logging is
            // on when ANY pool node has it — so never claim "applied" when the toggle could not take effect.
            const st = await this.swarmProxy.accessLogState(server.clusterId!, serverId);
            if (!st.inPool) {
              apply = "not-in-pool";
            } else {
              await this.swarmProxy.ensure(server.clusterId!);
              if (st.effective !== enabled) apply = "cluster-shared";
            }
          }
        }
      } else {
        // Classic: re-create only a RUNNING proxy. A stopped one was stopped on purpose (freeing :80/:443,
        // tunnel-only, ...) and recreating it would silently resurrect it; an absent one picks the flag up when
        // ensureProxy/start first creates it. Either way the saved flag is honored then ("deferred").
        const st = await this.agentWs.sendCommand(serverId, buildProxyStatusScript(), "deploy", PROXY_TIMEOUT_MS);
        if (parseStatus(st.output) !== "running") {
          apply = "deferred";
        } else {
          await this.recreateClassic(serverId);
          // OFF: the access log holds client IPs — drop it (and its rotation config) rather than leave it behind.
          // Best-effort: a cleanup hiccup must not turn a successful toggle into a failure.
          if (!enabled) {
            try {
              await this.agentWs.sendCommand(serverId, buildProxyAccessLogCleanupScript(), "deploy", PROXY_TIMEOUT_MS);
            } catch {
              /* leave it for the next toggle/recreate */
            }
          }
        }
      }
    } catch (e) {
      apply = "failed";
      applyError = (e instanceof Error ? e.message : "re-apply failed").slice(0, 500);
    }
    await this.audit.log({
      actor: userId,
      action: "server.traffic_analytics.update",
      target: serverId,
      meta: { enabled, apply },
    });
    return { trafficAnalytics: enabled, apply, applyError };
  }

  async stop(userId: string, serverId: string): Promise<{ status: ProxyStatus }> {
    await this.requireWrite(userId, serverId);
    await this.agentWs.sendCommand(serverId, buildProxyStopScript(), "deploy", PROXY_TIMEOUT_MS);
    await this.audit.log({ actor: userId, action: "server.proxy.stop", target: serverId });
    return this.statusAfter(serverId);
  }

  async restart(userId: string, serverId: string): Promise<{ status: ProxyStatus }> {
    await this.requireWrite(userId, serverId);
    await this.agentWs.sendCommand(serverId, buildProxyRestartScript(), "deploy", PROXY_TIMEOUT_MS);
    await this.audit.log({ actor: userId, action: "server.proxy.restart", target: serverId });
    return this.statusAfter(serverId);
  }

  async logs(userId: string, serverId: string, tail = 200): Promise<{ output: string }> {
    await this.requireWrite(userId, serverId);
    const r = await this.agentWs.sendCommand(serverId, buildProxyLogsScript(tail), "deploy", PROXY_TIMEOUT_MS);
    return { output: r.output.slice(0, 65536) };
  }

  // ── Dynamic configuration files (Coolify "Proxy > Dynamic Configurations" parity) ──────────────────────
  // Operator-authored Traefik dynamic-config YAML, written to the proxy's /dynamic as `user-<name>.yml` (so it
  // never collides with the Tugra-managed panel.yml / tls-*.yml). Server-admin scoped (servers:ops) — a server
  // owner already controls the whole box, so this is NOT the per-app label-hijack surface (that stays blocked).

  async listDynamicConfigs(userId: string, serverId: string): Promise<{ configs: { name: string; content: string; updatedAt: Date }[] }> {
    await this.requireRead(userId, serverId);
    const configs = await this.prisma.proxyDynamicConfig.findMany({
      where: { serverId },
      orderBy: { name: "asc" },
      select: { name: true, content: true, updatedAt: true },
    });
    return { configs };
  }

  async putDynamicConfig(userId: string, serverId: string, name: string, content: string): Promise<void> {
    await this.requireWrite(userId, serverId);
    if (!PROXY_DYNAMIC_NAME_RE.test(name)) throw new BadRequestException("invalid config name");
    // Validate it parses as a YAML mapping (Traefik config is an http:/tls:/tcp: map) BEFORE touching the
    // proxy — a syntax error is caught here with a clear 400 instead of silently taking routes offline on
    // Traefik's next reload.
    let doc: unknown;
    try {
      doc = parseYaml(content);
    } catch (e) {
      throw new BadRequestException(`invalid YAML: ${e instanceof Error ? e.message : "parse error"}`);
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new BadRequestException("the config must be a YAML mapping (e.g. start with `http:` or `tls:`)");
    }
    const existing = await this.prisma.proxyDynamicConfig.findUnique({ where: { serverId_name: { serverId, name } }, select: { id: true } });
    if (!existing && (await this.prisma.proxyDynamicConfig.count({ where: { serverId } })) >= MAX_DYNAMIC_CONFIGS) {
      throw new BadRequestException(`too many dynamic config files (max ${MAX_DYNAMIC_CONFIGS})`);
    }
    // Write to the proxy FIRST — if the agent is offline or the write fails, nothing is persisted (fail-closed).
    const r = await this.agentWs.sendCommand(serverId, buildProxyDynamicWriteScript(name, content), "deploy", PROXY_TIMEOUT_MS);
    if (r.exitCode !== 0) throw new BadRequestException(`writing the dynamic config failed: ${r.output.trim().slice(-500)}`);
    await this.prisma.proxyDynamicConfig.upsert({
      where: { serverId_name: { serverId, name } },
      create: { serverId, name, content },
      update: { content },
    });
    await this.audit.log({ actor: userId, action: "server.proxy.dynamic.put", target: serverId, meta: { name } });
  }

  async deleteDynamicConfig(userId: string, serverId: string, name: string): Promise<void> {
    await this.requireWrite(userId, serverId);
    await this.prisma.proxyDynamicConfig.deleteMany({ where: { serverId, name } });
    await this.agentWs.sendCommand(serverId, buildProxyDynamicRemoveScript(name), "deploy", PROXY_TIMEOUT_MS);
    await this.audit.log({ actor: userId, action: "server.proxy.dynamic.delete", target: serverId, meta: { name } });
  }

  private async statusAfter(serverId: string): Promise<{ status: ProxyStatus }> {
    const r = await this.agentWs.sendCommand(serverId, buildProxyStatusScript(), "deploy", PROXY_TIMEOUT_MS);
    return { status: parseStatus(r.output) };
  }

  private async requireRead(userId: string, serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    if (!(await this.access.teamRole(userId, server.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
  }

  private async requireWrite(userId: string, serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
  }
}

import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AuditService } from "../audit/audit.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { ProxyConfigService } from "../proxy-config/proxy-config.service";
import { ProxyService } from "./proxy.service";
import { validateAcmeEmail, PROXY_DYNAMIC_DIR, PANEL_FILE } from "../deploy/panel-router";

export const PanelTlsStatusSchema = z.object({
  enabled: z.boolean(), // a panel domain is configured (install.sh --auto-tls / env / DB)
  domain: z.string().nullable(),
  resolver: z.string().nullable(), // "le" | "le-dns" | null (null = not resolvable, e.g. invalid email)
  originHost: z.string().nullable(), // host of WEB_PUBLIC_URL — the panel domain must equal this
  originMatches: z.boolean(),
  acmeEmailOk: z.boolean(),
  localServerId: z.string().nullable(),
  localServerOnline: z.boolean(),
  proxyRunning: z.boolean(),
  routerPresent: z.boolean(), // the panel.yml router file exists on the local server
});
export type PanelTlsStatus = z.infer<typeof PanelTlsStatusSchema>;

function hostOf(u?: string | null): string | null {
  if (!u) return null;
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}

/**
 * Panel-TLS (DİLİM 1) owner surface: a read-only STATUS and an idempotent APPLY (repair/re-provision) for the
 * control panel's HTTPS. install.sh --auto-tls is the primary enable path; this is how an owner checks it and
 * re-applies it later (e.g. after switching the server to DNS-01). Community-free; owner-only (controller guard).
 */
@Injectable()
export class PanelTlsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly agentWs: AgentWsServer,
    private readonly audit: AuditService,
    private readonly settings: InstanceSettingsService,
    private readonly proxyConfig: ProxyConfigService,
    private readonly proxy: ProxyService,
  ) {}

  async status(): Promise<PanelTlsStatus> {
    const domain = await this.settings.panelDomainFor(
      this.config.get<string>("PANEL_DOMAIN"),
      this.config.get<string>("PANEL_TLS"),
    );
    const originHost = hostOf(this.config.get<string>("WEB_PUBLIC_URL"));
    const acmeEmail = await this.settings.acmeEmailFor(this.config.get<string>("ACME_EMAIL"));
    let acmeEmailOk = false;
    try {
      validateAcmeEmail(acmeEmail ?? "");
      acmeEmailOk = true;
    } catch {
      acmeEmailOk = false;
    }

    const local = await this.prisma.server
      .findFirst({ where: { isLocal: true }, select: { id: true, status: true } })
      .catch(() => null);

    let resolver: string | null = null;
    let proxyRunning = false;
    let routerPresent = false;
    if (local) {
      const cfg = await this.proxyConfig.resolveFor(local.id).catch(() => null);
      resolver = cfg?.panel?.resolver ?? null;
      if (local.status === "ONLINE") {
        try {
          const probe = `docker inspect -f '{{.State.Running}}' tugra-proxy 2>/dev/null || echo false; test -f ${PROXY_DYNAMIC_DIR}/${PANEL_FILE} && echo RF:1 || echo RF:0`;
          const r = await this.agentWs.sendCommand(local.id, probe, "deploy", 15_000);
          proxyRunning = /\btrue\b/.test(r.output);
          routerPresent = /RF:1/.test(r.output);
        } catch {
          /* leave probe fields false — never fail the status read */
        }
      }
    }

    return {
      enabled: !!domain,
      domain: domain ?? null,
      resolver,
      originHost,
      originMatches: !!domain && !!originHost && domain === originHost,
      acmeEmailOk,
      localServerId: local?.id ?? null,
      localServerOnline: local?.status === "ONLINE",
      proxyRunning,
      routerPresent,
    };
  }

  /** (Re)provision the panel HTTPS on the local server. Idempotent; recreates the proxy WITH the panel router.
   *  Owner-only (controller guard). Throws a clear 4xx when it can't run so nothing half-applies. */
  async apply(userId: string): Promise<PanelTlsStatus> {
    const local = await this.prisma.server
      .findFirst({ where: { isLocal: true }, select: { id: true, status: true } })
      .catch(() => null);
    if (!local) throw new BadRequestException("no local server to host the panel");
    if (local.status !== "ONLINE") throw new ConflictException("the local server is offline — start it and retry");
    const cfg = await this.proxyConfig.resolveFor(local.id);
    if (!cfg.panel) {
      throw new BadRequestException(
        "panel TLS is not configured — set a panel domain (install.sh --auto-tls, or PANEL_DOMAIN) and a real ACME email first",
      );
    }
    // ensureProxy recreates the proxy with the file provider + panel router (+ the tugra-panel attach); it
    // throws on a non-zero exit AND refuses on a swarm-manager host, so a failure never looks like success.
    await this.proxy.ensureProxy(local.id);
    await this.audit.log({ actor: userId, action: "instance.panel_tls.apply", target: local.id });
    return this.status();
  }
}

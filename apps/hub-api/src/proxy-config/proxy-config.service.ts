import { Injectable, OnApplicationBootstrap, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { RedisService } from "../redis/redis.service";
import { validatePanelDomain, optionalAcmeEmail, dnsProviderEnvCreds, type PanelResolver } from "../deploy/panel-router";
import { PANEL_PENDING_KEY, parsePanelPending } from "./panel-pending";

export interface ResolvedProxyConfig {
  acmeEmail?: string;
  bind?: string | null;
  dnsProvider?: string | null;
  dnsCreds?: Record<string, string> | null;
  // Panel-TLS (DİLİM 1): a {domain, resolver} for the LOCAL server when panel TLS is on and valid; otherwise
  // undefined (leave the panel file untouched). Removal of the router is a separate, explicit op.
  // `domain` is null only for the host-less http://<ip>/ panel of a plain install; `also` = hosts served at the same
  // time (the OLD host while a domain change is verified); `ipRoute` = the host-less http route (PANEL_IP_ROUTE=1).
  panel?: { domain: string | null; resolver: PanelResolver; also?: string[]; ipRoute?: boolean };
  // Traffic Analytics: true when the server opted in — the proxy then writes a JSON access log to the host.
  accessLog?: boolean; // always set by resolveFor; optional only so hand-built fixtures stay valid
}

/**
 * Single source of truth for a server's proxy configuration (DİLİM 1). Both recreate paths —
 * ProxyService.ensureProxy (every domained deploy) and ProxyOpsService.start — resolve through here, so the
 * Traefik flags and the panel router can never drift between them. It absorbs the old per-service
 * proxyConfig()/dnsConfig() helpers and adds the panel decision for the local server.
 */
@Injectable()
export class ProxyConfigService implements OnApplicationBootstrap {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly settings: InstanceSettingsService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  /** install.sh --auto-tls writes PANEL_TLS=1 + PANEL_DOMAIN; mirror that explicit operator intent into the
   *  DB once at boot so the hub (ensureProxy) has it even before the local agent exists. Env unset => DB untouched. */
  async onApplicationBootstrap(): Promise<void> {
    const envDomain = this.config.get<string>("PANEL_DOMAIN");
    const envFlag = this.config.get<string>("PANEL_TLS");
    if (envFlag === "1" && envDomain && envDomain.trim()) {
      const d = envDomain.trim();
      const s = await this.settings.get().catch(() => null);
      if (s && s.panelDomain !== d) await this.settings.update({ panelDomain: d }).catch(() => undefined);
    }
  }

  async resolveFor(serverId: string): Promise<ResolvedProxyConfig> {
    const acmeEmail = await this.settings.acmeEmailFor(this.config.get<string>("ACME_EMAIL"));
    const s = await this.prisma.server
      .findUnique({
        where: { id: serverId },
        select: { isLocal: true, certMode: true, dnsProvider: true, dnsCredsEnc: true, proxyBind: true, trafficAnalytics: true },
      })
      .catch(() => null);
    const bind = s?.proxyBind;

    // DNS-01 creds, only when certMode is "le-dns" with DECRYPTABLE creds (same fail-safe as before: an
    // unreadable blob sets up the proxy without the DNS resolver rather than throwing).
    let dnsProvider: string | null | undefined;
    let dnsCreds: Record<string, string> | null | undefined;
    let dnsUsable = false;
    if (s && s.certMode === "le-dns" && s.dnsProvider && s.dnsCredsEnc) {
      try {
        dnsCreds = JSON.parse(this.crypto.decrypt(s.dnsCredsEnc));
        dnsProvider = s.dnsProvider;
        dnsUsable = true;
      } catch {
        dnsUsable = false;
      }
    }
    // Local-server panel fallback: install.sh --acme-dns-cloudflare writes the token to env (ACME_DNS_*) — the
    // local server row has no stored creds yet. Honor it HERE so every hub-driven recreate keeps le-dns (a real
    // cert while proxied); without this the first redeploy would silently revert the panel to HTTP-01.
    if (!dnsUsable && s?.isLocal === true) {
      const envProvider = this.config.get<string>("ACME_DNS_PROVIDER")?.trim();
      const envToken = this.config.get<string>("ACME_DNS_TOKEN")?.trim();
      if (envProvider && envToken) {
        try {
          dnsCreds = dnsProviderEnvCreds(envProvider, envToken);
          dnsProvider = envProvider;
          dnsUsable = true;
        } catch {
          dnsUsable = false; // unsupported provider → fall back to HTTP-01
        }
      }
    }

    const panel = await this.resolvePanel(s?.isLocal === true, acmeEmail, dnsUsable);
    return { acmeEmail, bind, dnsProvider, dnsCreds, accessLog: s?.trafficAnalytics === true, ...(panel ? { panel } : {}) };
  }

  /** The panel config — ONLY for the local server, when a panel domain is set or the host-less IP route is on
   *  (PANEL_IP_ROUTE=1, a plain install). The ACME email is OPTIONAL (blank = a resolver without a contact) but one
   *  that IS set must be real, else the panel is omitted (status surfaces why). While a domain change is in flight
   *  (PANEL_PENDING_KEY) the NEW host is rendered next to what works today, so the current URL keeps working until
   *  the change is verified. resolver is derived: "le-dns" when the local server has usable DNS-01 creds (for a
   *  Cloudflare-proxied record), else "le". Returns undefined (never throws) so a recreate can't blow up mid-deploy. */
  private async resolvePanel(
    isLocal: boolean,
    acmeEmail: string | undefined,
    dnsUsable: boolean,
  ): Promise<ResolvedProxyConfig["panel"]> {
    if (!isLocal) return undefined;
    const raw = await this.settings.panelDomainFor(
      this.config.get<string>("PANEL_DOMAIN"),
      this.config.get<string>("PANEL_TLS"),
    );
    const envIpRoute = this.config.get<string>("PANEL_IP_ROUTE")?.trim() === "1";
    const pending = await this.readPending();
    try {
      optionalAcmeEmail(acmeEmail ?? "");
      const current = raw ? validatePanelDomain(raw) : null;
      let domain: string | null = current;
      const also: string[] = [];
      let ipRoute = envIpRoute;
      if (pending) {
        if (pending.domain === null) {
          ipRoute = true; // removing the domain: the IP route goes live BEFORE the URLs are switched
        } else {
          domain = validatePanelDomain(pending.domain);
          if (current && current !== domain) also.push(current);
        }
      }
      if (!domain && !ipRoute) return undefined;
      return { domain, resolver: dnsUsable ? "le-dns" : "le", ...(also.length ? { also } : {}), ...(ipRoute ? { ipRoute: true } : {}) };
    } catch {
      return undefined;
    }
  }

  private async readPending() {
    if (!this.redis) return null;
    try {
      return parsePanelPending(await this.redis.get(PANEL_PENDING_KEY));
    } catch {
      return null; // Redis hiccup: resolve from the stored config rather than fail a deploy
    }
  }
}

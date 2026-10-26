import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { validatePanelDomain, validateAcmeEmail, type PanelResolver } from "../deploy/panel-router";

export interface ResolvedProxyConfig {
  acmeEmail?: string;
  bind?: string | null;
  dnsProvider?: string | null;
  dnsCreds?: Record<string, string> | null;
  // Panel-TLS (DİLİM 1): a {domain, resolver} for the LOCAL server when panel TLS is on and valid; otherwise
  // undefined (leave the panel file untouched). Removal of the router is a separate, explicit op.
  panel?: { domain: string; resolver: PanelResolver };
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
        select: { isLocal: true, certMode: true, dnsProvider: true, dnsCredsEnc: true, proxyBind: true },
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

    const panel = await this.resolvePanel(s?.isLocal === true, acmeEmail, dnsUsable);
    return { acmeEmail, bind, dnsProvider, dnsCreds, ...(panel ? { panel } : {}) };
  }

  /** The panel config — ONLY for the local server, when a panel domain is set AND the ACME email is valid.
   *  resolver is derived: "le-dns" when the local server has usable DNS-01 creds (for a Cloudflare-proxied
   *  record), else "le". Returns undefined (never throws) so a recreate can't blow up mid-deploy. */
  private async resolvePanel(
    isLocal: boolean,
    acmeEmail: string | undefined,
    dnsUsable: boolean,
  ): Promise<{ domain: string; resolver: PanelResolver } | undefined> {
    if (!isLocal) return undefined;
    const raw = await this.settings.panelDomainFor(
      this.config.get<string>("PANEL_DOMAIN"),
      this.config.get<string>("PANEL_TLS"),
    );
    if (!raw) return undefined;
    try {
      const domain = validatePanelDomain(raw);
      validateAcmeEmail(acmeEmail ?? ""); // a placeholder/missing email omits the panel (status surfaces why)
      return { domain, resolver: dnsUsable ? "le-dns" : "le" };
    } catch {
      return undefined;
    }
  }
}

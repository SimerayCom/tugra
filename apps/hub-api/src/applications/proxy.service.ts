import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { buildProxySetupScript } from "../deploy/deploy-script";

/** Ensures the Traefik reverse-proxy is running on a server (idempotent). */
@Injectable()
export class ProxyService {
  constructor(
    private readonly config: ConfigService,
    private readonly agentWs: AgentWsServer,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async ensureProxy(serverId: string): Promise<void> {
    // Coexistence guard: a swarm manager runs the swarm-mode Traefik on :80/:443. Standing up the classic
    // per-server proxy here would collide (a later `docker run -p 80:80` fails loudly, or worse silently
    // half-works). Refuse — this server is dedicated to swarm ingress.
    const swarmManaged = await this.prisma.cluster.count({
      where: { swarmManagerId: serverId, swarmStatus: { in: ["ACTIVE", "DEGRADED", "FORMING", "DISSOLVING"] } },
    });
    if (swarmManaged > 0) {
      throw new BadRequestException(
        "this server is a swarm manager (it runs the cluster's swarm ingress on :80/:443) — domain-routed single-server apps can't be deployed directly here",
      );
    }
    const email = this.config.get<string>("ACME_EMAIL");
    const dns = await this.dnsConfig(serverId);
    await this.agentWs.sendCommand(
      serverId,
      buildProxySetupScript({ acmeEmail: email, ...dns }),
      "deploy",
      60_000,
    );
  }

  /** The server's DNS-01 provider + decrypted creds, when certMode is "le-dns". */
  private async dnsConfig(
    serverId: string,
  ): Promise<{ dnsProvider?: string | null; dnsCreds?: Record<string, string> | null }> {
    const s = await this.prisma.server
      .findUnique({ where: { id: serverId }, select: { certMode: true, dnsProvider: true, dnsCredsEnc: true } })
      .catch(() => null);
    if (!s || s.certMode !== "le-dns" || !s.dnsProvider || !s.dnsCredsEnc) return {};
    try {
      return { dnsProvider: s.dnsProvider, dnsCreds: JSON.parse(this.crypto.decrypt(s.dnsCredsEnc)) };
    } catch {
      return {}; // unreadable creds → set up the proxy without the DNS resolver (fail-safe)
    }
  }
}

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { CloudflareApiClient } from "../tunnel/cloudflare-api.client";
import type { CreateDnsCredentialInput, UpdateDnsCredentialInput } from "./dto";

export interface DnsCredentialView {
  id: string;
  name: string;
  teamId: string;
  provider: string;
  cfAccountId: string | null;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  canWrite: boolean;
}
interface DnsCredentialRow {
  id: string;
  name: string;
  teamId: string;
  provider: string;
  cfAccountId: string | null;
  lastVerifiedAt: Date | null;
  createdAt: Date;
}

/**
 * Team-scoped DNS-provider API credentials (mirrors CloudCredentialsService). The token is verified against
 * the provider BEFORE it is encrypted+persisted, is NEVER returned by any view, and is gated by the
 * `integrations` team permission. v1 supports Cloudflare only.
 */
@Injectable()
export class DnsCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly cf: CloudflareApiClient,
  ) {}

  private view(r: DnsCredentialRow, canWrite: boolean): DnsCredentialView {
    // The encrypted API token is NEVER included in the outward view.
    return {
      id: r.id,
      name: r.name,
      teamId: r.teamId,
      provider: r.provider,
      cfAccountId: r.cfAccountId,
      lastVerifiedAt: r.lastVerifiedAt,
      createdAt: r.createdAt,
      canWrite,
    };
  }

  async list(userId: string): Promise<DnsCredentialView[]> {
    const perms = await this.access.permissionsByTeam(userId);
    const teamIds = [...perms.keys()];
    if (!teamIds.length) return [];
    const rows = await this.prisma.dnsCredential.findMany({ where: { teamId: { in: teamIds } }, orderBy: { createdAt: "desc" } });
    return rows.map((r) => this.view(r, perms.get(r.teamId)?.has("integrations") ?? false));
  }

  async create(userId: string, dto: CreateDnsCredentialInput): Promise<DnsCredentialView> {
    await this.access.requirePermission(userId, dto.teamId, "integrations");
    await this.verify(dto.apiToken, dto.cfAccountId); // verify BEFORE persisting anything
    const r = await this.prisma.dnsCredential.create({
      data: {
        teamId: dto.teamId,
        name: dto.name,
        provider: dto.provider,
        apiTokenEnc: this.crypto.encrypt(dto.apiToken),
        cfAccountId: dto.cfAccountId ?? null,
        lastVerifiedAt: new Date(),
      },
    });
    await this.audit.log({ actor: userId, action: "dns_credential.create", target: r.id, meta: { provider: dto.provider } });
    return this.view(r, true);
  }

  async update(userId: string, id: string, dto: UpdateDnsCredentialInput): Promise<DnsCredentialView> {
    const existing = await this.prisma.dnsCredential.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("dns credential not found");
    await this.access.requirePermission(userId, existing.teamId, "integrations");
    // Re-verify a new token before storing it, against the effective account id (incoming override else stored).
    if (dto.apiToken) await this.verify(dto.apiToken, dto.cfAccountId !== undefined ? dto.cfAccountId : existing.cfAccountId);
    const r = await this.prisma.dnsCredential.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        // Only re-encrypt the token when a new one is supplied (write-only field); refresh lastVerifiedAt then.
        ...(dto.apiToken ? { apiTokenEnc: this.crypto.encrypt(dto.apiToken), lastVerifiedAt: new Date() } : {}),
        ...(dto.cfAccountId !== undefined ? { cfAccountId: dto.cfAccountId } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "dns_credential.update", target: id });
    return this.view(r, true);
  }

  async remove(userId: string, id: string): Promise<void> {
    const r = await this.prisma.dnsCredential.findUnique({ where: { id } });
    if (!r) throw new NotFoundException("dns credential not found");
    await this.access.requirePermission(userId, r.teamId, "integrations");
    await this.prisma.dnsCredential.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "dns_credential.remove", target: id });
  }

  /** Re-verify the stored token still authenticates against the provider. */
  async test(userId: string, id: string): Promise<{ ok: true }> {
    const r = await this.prisma.dnsCredential.findUnique({ where: { id } });
    if (!r) throw new NotFoundException("dns credential not found");
    await this.access.requirePermission(userId, r.teamId, "integrations");
    await this.verify(this.crypto.decrypt(r.apiTokenEnc), r.cfAccountId);
    await this.prisma.dnsCredential.update({ where: { id }, data: { lastVerifiedAt: new Date() } });
    await this.audit.log({ actor: userId, action: "dns_credential.test", target: id });
    return { ok: true };
  }

  /**
   * Internal: decrypt a credential's token for a DNS automation call. Enforces the caller's `integrations`
   * permission on the credential's own team. NEVER exposed via the controller — the token stays in-process.
   */
  async resolveToken(userId: string, credentialId: string): Promise<{ token: string; cfAccountId: string | null; provider: string; teamId: string }> {
    const r = await this.prisma.dnsCredential.findUnique({ where: { id: credentialId } });
    if (!r) throw new NotFoundException("dns credential not found");
    await this.access.requirePermission(userId, r.teamId, "integrations");
    return { token: this.crypto.decrypt(r.apiTokenEnc), cfAccountId: r.cfAccountId, provider: r.provider, teamId: r.teamId };
  }

  /** The team's Cloudflare credentials (id + account id), for picking a default when none is specified. */
  async cloudflareCredentialsForTeam(teamId: string): Promise<Array<{ id: string; cfAccountId: string | null }>> {
    const rows = await this.prisma.dnsCredential.findMany({
      where: { teamId, provider: "cloudflare" },
      select: { id: true, cfAccountId: true },
      orderBy: { createdAt: "asc" },
    });
    return rows;
  }

  private async verify(token: string, accountId?: string | null): Promise<void> {
    const { valid } = await this.cf.verifyToken(token, accountId ?? undefined);
    if (!valid) throw new BadRequestException("the DNS provider rejected this API token");
  }
}

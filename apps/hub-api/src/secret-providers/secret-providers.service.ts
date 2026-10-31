import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { filterByQuery } from "../common/query-filter";
import { VaultApiClient } from "./vault-api.client";
import type { CreateSecretProviderInput, UpdateSecretProviderInput } from "./dto";

export interface SecretProviderView {
  id: string;
  name: string;
  teamId: string;
  kind: string;
  address: string;
  lastVerifiedAt: Date | null;
  refCount: number;
  createdAt: Date;
  canWrite: boolean;
}
interface SecretProviderRow {
  id: string;
  name: string;
  teamId: string;
  kind: string;
  address: string;
  lastVerifiedAt: Date | null;
  createdAt: Date;
}

/**
 * Team-scoped external secret-store providers (mirrors DnsCredentialsService). The access token is verified
 * against the store BEFORE it is encrypted+persisted, is NEVER returned by any view, and management is gated
 * by the `integrations` team permission. v1 supports HashiCorp Vault (KV v2) only; other kinds are rejected
 * at create until they get a client. The deploy env resolver (AppSecretRefsService) fetches referenced
 * secrets through these providers at deploy time — this service never returns a secret value.
 */
@Injectable()
export class SecretProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly vault: VaultApiClient,
  ) {}

  private view(r: SecretProviderRow, refCount: number, canWrite: boolean): SecretProviderView {
    // The encrypted access token is NEVER included in the outward view.
    return {
      id: r.id,
      name: r.name,
      teamId: r.teamId,
      kind: r.kind,
      address: r.address,
      lastVerifiedAt: r.lastVerifiedAt,
      refCount,
      createdAt: r.createdAt,
      canWrite,
    };
  }

  async list(userId: string, q?: string): Promise<SecretProviderView[]> {
    const perms = await this.access.permissionsByTeam(userId);
    const teamIds = [...perms.keys()];
    if (!teamIds.length) return [];
    const rows = await this.prisma.secretProvider.findMany({
      where: { teamId: { in: teamIds } },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { refs: true } } },
    });
    const views = rows.map((r) =>
      this.view(r, r._count.refs, perms.get(r.teamId)?.has("integrations") ?? false),
    );
    return filterByQuery(views, q, (c) => [c.name, c.kind, c.address]);
  }

  async create(userId: string, dto: CreateSecretProviderInput): Promise<SecretProviderView> {
    await this.access.requirePermission(userId, dto.teamId, "integrations");
    await this.verify(dto.kind, dto.address, dto.token); // verify BEFORE persisting anything
    const r = await this.prisma.secretProvider.create({
      data: {
        teamId: dto.teamId,
        name: dto.name,
        kind: dto.kind,
        address: dto.address,
        tokenEnc: this.crypto.encrypt(dto.token),
        lastVerifiedAt: new Date(),
      },
    });
    await this.audit.log({ actor: userId, action: "secret_provider.create", target: r.id, meta: { kind: dto.kind } });
    return this.view(r, 0, true);
  }

  async update(userId: string, id: string, dto: UpdateSecretProviderInput): Promise<SecretProviderView> {
    const existing = await this.prisma.secretProvider.findUnique({
      where: { id },
      include: { _count: { select: { refs: true } } },
    });
    if (!existing) throw new NotFoundException("secret provider not found");
    await this.access.requirePermission(userId, existing.teamId, "integrations");
    // Re-verify a new token (or a changed address) before storing it, using the effective address + token.
    const effAddress = dto.address ?? existing.address;
    if (dto.token || (dto.address && dto.address !== existing.address)) {
      const effToken = dto.token ?? this.crypto.decrypt(existing.tokenEnc);
      await this.verify(existing.kind, effAddress, effToken);
    }
    const r = await this.prisma.secretProvider.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        // Only re-encrypt the token when a new one is supplied (write-only field); refresh lastVerifiedAt
        // whenever we re-verified (new token, or an address change we re-checked the stored token against).
        ...(dto.token ? { tokenEnc: this.crypto.encrypt(dto.token) } : {}),
        ...(dto.token || (dto.address && dto.address !== existing.address) ? { lastVerifiedAt: new Date() } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "secret_provider.update", target: id });
    return this.view(r, existing._count.refs, true);
  }

  async remove(userId: string, id: string): Promise<void> {
    const r = await this.prisma.secretProvider.findUnique({ where: { id } });
    if (!r) throw new NotFoundException("secret provider not found");
    await this.access.requirePermission(userId, r.teamId, "integrations");
    const refs = await this.prisma.secretRef.count({ where: { providerId: id } });
    if (refs > 0) {
      throw new ConflictException(`this provider is still used by ${refs} app secret${refs === 1 ? "" : "s"} — remove those first`);
    }
    await this.prisma.secretProvider.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "secret_provider.remove", target: id });
  }

  /** Re-verify the stored token still authenticates against the store. */
  async test(userId: string, id: string): Promise<{ ok: true }> {
    const r = await this.prisma.secretProvider.findUnique({ where: { id } });
    if (!r) throw new NotFoundException("secret provider not found");
    await this.access.requirePermission(userId, r.teamId, "integrations");
    await this.verify(r.kind, r.address, this.crypto.decrypt(r.tokenEnc));
    await this.prisma.secretProvider.update({ where: { id }, data: { lastVerifiedAt: new Date() } });
    await this.audit.log({ actor: userId, action: "secret_provider.test", target: id });
    return { ok: true };
  }

  /** Verify a credential against its store. A rejected token → BadRequest; an unreachable store → BadRequest
   *  (the client distinguishes them internally, but both are a 400 to the caller: the credential is unusable). */
  private async verify(kind: string, address: string, token: string): Promise<void> {
    if (kind !== "vault") throw new BadRequestException(`unsupported secret provider kind: ${kind}`);
    let valid = false;
    try {
      ({ valid } = await this.vault.verify(address, token));
    } catch {
      throw new BadRequestException("could not reach the secret store at the given address");
    }
    if (!valid) throw new BadRequestException("the secret store rejected this token");
  }
}

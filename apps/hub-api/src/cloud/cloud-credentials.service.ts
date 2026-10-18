import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { CloudProviderFactory } from "./providers/provider-factory.service";
import { filterByQuery } from "../common/query-filter";
import type { CreateCloudCredentialInput, UpdateCloudCredentialInput } from "./dto";

export interface CloudCredentialView {
  id: string;
  name: string;
  teamId: string;
  provider: string;
  createdAt: Date;
  canWrite: boolean;
}
interface CloudCredentialRow {
  id: string;
  name: string;
  teamId: string;
  provider: string;
  createdAt: Date;
}

/**
 * Team-scoped cloud-provider API credentials (mirrors RegistriesService). The API token is verified
 * against the provider BEFORE it is encrypted+persisted, and is NEVER returned by any view.
 */
@Injectable()
export class CloudCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly providers: CloudProviderFactory,
  ) {}

  private view(r: CloudCredentialRow, canWrite: boolean): CloudCredentialView {
    // The encrypted API token is NEVER included in the outward view.
    return { id: r.id, name: r.name, teamId: r.teamId, provider: r.provider, createdAt: r.createdAt, canWrite };
  }

  async list(userId: string, q?: string): Promise<CloudCredentialView[]> {
    const perms = await this.access.permissionsByTeam(userId);
    const teamIds = [...perms.keys()];
    if (!teamIds.length) return [];
    const rows = await this.prisma.cloudCredential.findMany({
      where: { teamId: { in: teamIds } },
      orderBy: { createdAt: "desc" },
    });
    const views = rows.map((r) => this.view(r, perms.get(r.teamId)?.has("integrations") ?? false));
    return filterByQuery(views, q, (c) => [c.name, c.provider]);
  }

  async create(userId: string, dto: CreateCloudCredentialInput): Promise<CloudCredentialView> {
    await this.access.requirePermission(userId, dto.teamId, "integrations");
    await this.verify(dto.provider, dto.apiToken); // verify BEFORE persisting anything
    const r = await this.prisma.cloudCredential.create({
      data: {
        teamId: dto.teamId,
        name: dto.name,
        provider: dto.provider,
        apiTokenEnc: this.crypto.encrypt(dto.apiToken),
      },
    });
    await this.audit.log({ actor: userId, action: "cloud_credential.create", target: r.id, meta: { provider: dto.provider } });
    return this.view(r, true);
  }

  async update(userId: string, id: string, dto: UpdateCloudCredentialInput): Promise<CloudCredentialView> {
    const existing = await this.prisma.cloudCredential.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("cloud credential not found");
    await this.access.requirePermission(userId, existing.teamId, "integrations");
    if (dto.apiToken) await this.verify(existing.provider, dto.apiToken); // re-verify a new token before storing it
    const r = await this.prisma.cloudCredential.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        // Only re-encrypt the token when a new one is supplied (write-only field).
        ...(dto.apiToken ? { apiTokenEnc: this.crypto.encrypt(dto.apiToken) } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "cloud_credential.update", target: id });
    return this.view(r, true);
  }

  async remove(userId: string, id: string): Promise<void> {
    const r = await this.prisma.cloudCredential.findUnique({ where: { id } });
    if (!r) throw new NotFoundException("cloud credential not found");
    await this.access.requirePermission(userId, r.teamId, "integrations");
    await this.prisma.cloudCredential.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "cloud_credential.remove", target: id });
  }

  /** Re-verify the stored token still authenticates against the provider. */
  async test(userId: string, id: string): Promise<{ ok: true }> {
    const r = await this.prisma.cloudCredential.findUnique({ where: { id } });
    if (!r) throw new NotFoundException("cloud credential not found");
    await this.access.requirePermission(userId, r.teamId, "integrations");
    await this.verify(r.provider, this.crypto.decrypt(r.apiTokenEnc));
    await this.audit.log({ actor: userId, action: "cloud_credential.test", target: id });
    return { ok: true };
  }

  private async verify(provider: string, token: string): Promise<void> {
    const { valid } = await this.providers.get(provider).verifyToken(token);
    if (!valid) throw new BadRequestException("the cloud provider rejected this API token");
  }
}

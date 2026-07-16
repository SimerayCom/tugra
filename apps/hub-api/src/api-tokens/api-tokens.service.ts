import { Injectable, NotFoundException } from "@nestjs/common";
import { ApiToken } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { AuthUser } from "../auth/strategies/jwt.strategy";
import {
  generateApiToken,
  hashToken,
  isApiToken,
  tokenPrefix,
} from "./api-token.util";
import type { CreateApiTokenInput } from "./dto";

export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class ApiTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    userId: string,
    dto: CreateApiTokenInput,
  ): Promise<{ token: string; view: ApiTokenView }> {
    const raw = generateApiToken();
    const expiresAt = dto.expiresInDays
      ? new Date(Date.now() + dto.expiresInDays * 86400_000)
      : null;
    const t = await this.prisma.apiToken.create({
      data: {
        userId,
        name: dto.name,
        scopes: dto.scopes,
        tokenHash: hashToken(raw),
        prefix: tokenPrefix(raw),
        expiresAt,
      },
    });
    await this.audit.log({ actor: userId, action: "api_token.create", target: t.id });
    return { token: raw, view: this.view(t) };
  }

  async list(userId: string): Promise<ApiTokenView[]> {
    const tokens = await this.prisma.apiToken.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return tokens.map((t) => this.view(t));
  }

  async revoke(userId: string, id: string): Promise<void> {
    const t = await this.prisma.apiToken.findFirst({ where: { id, userId } });
    if (!t) throw new NotFoundException("token not found");
    await this.prisma.apiToken.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "api_token.revoke", target: id });
  }

  /** Resolve a raw bearer token to its owner, or null. Updates lastUsedAt. */
  async validate(raw: string): Promise<AuthUser | null> {
    if (!isApiToken(raw)) return null;
    const t = await this.prisma.apiToken.findUnique({
      where: { tokenHash: hashToken(raw) },
    });
    if (!t) return null;
    if (t.expiresAt && t.expiresAt.getTime() < Date.now()) return null;
    await this.prisma.apiToken
      .update({ where: { id: t.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return { userId: t.userId, scopes: t.scopes, tokenId: t.id };
  }

  private view(t: ApiToken): ApiTokenView {
    return {
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      scopes: t.scopes,
      expiresAt: t.expiresAt,
      lastUsedAt: t.lastUsedAt,
      createdAt: t.createdAt,
    };
  }
}

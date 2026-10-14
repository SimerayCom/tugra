import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
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
import type { CreateApiTokenInput, UpdateApiTokenInput } from "./dto";

// zod is the single source of truth for the response shape: it types the service AND generates the OpenAPI
// response schema (via @ApiZodResponse), so the docs can never drift from what the code returns.
export const ApiTokenViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.date().nullable(),
  lastUsedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type ApiTokenView = z.infer<typeof ApiTokenViewSchema>;

export const CreateApiTokenResultSchema = z.object({ token: z.string(), view: ApiTokenViewSchema });

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
        scopes: [...new Set(dto.scopes)],
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

  /** Rename and/or re-scope one of the caller's own tokens. Re-scoping may only NARROW — every requested scope
   *  must already be granted; widening is refused (mint a new token for more power). The secret is unchanged. */
  async update(userId: string, id: string, dto: UpdateApiTokenInput): Promise<ApiTokenView> {
    const t = await this.prisma.apiToken.findFirst({ where: { id, userId } });
    if (!t) throw new NotFoundException("token not found");
    const scopes = dto.scopes ? [...new Set(dto.scopes)] : undefined;
    if (scopes) {
      const granted = new Set(t.scopes);
      const widened = scopes.filter((s) => !granted.has(s));
      if (widened.length) {
        throw new BadRequestException(`cannot widen a token's scopes (${widened.join(", ")}) — create a new token instead`);
      }
    }
    const updated = await this.prisma.apiToken.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(scopes ? { scopes } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "api_token.update", target: id, ...(scopes ? { meta: { scopes } } : {}) });
    return this.view(updated);
  }

  /** Issue a fresh secret for an existing token (same id/name/scopes/expiry). The OLD secret stops working
   *  immediately (its hash is replaced); the new raw value is returned once, like create. */
  async rotate(userId: string, id: string): Promise<{ token: string; view: ApiTokenView }> {
    const t = await this.prisma.apiToken.findFirst({ where: { id, userId } });
    if (!t) throw new NotFoundException("token not found");
    if (t.expiresAt && t.expiresAt.getTime() < Date.now()) {
      // A rotated secret would inherit the past expiry and be rejected by validate() — refuse instead of
      // handing back a dead token with a misleading 200.
      throw new BadRequestException("token has expired — create a new one instead of rotating");
    }
    const raw = generateApiToken();
    const updated = await this.prisma.apiToken.update({
      where: { id },
      data: { tokenHash: hashToken(raw), prefix: tokenPrefix(raw), lastUsedAt: null },
    });
    await this.audit.log({ actor: userId, action: "api_token.rotate", target: id });
    return { token: raw, view: this.view(updated) };
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

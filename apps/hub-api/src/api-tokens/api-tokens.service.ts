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
import { COALESCE_WINDOW_MS, MAX_USES_PER_TOKEN, type UseInfo } from "./api-token-usage";

const OWNER_SELECT = { select: { id: true, name: true, email: true } } as const;
type TokenRow = ApiToken & { user?: { id: string; name: string | null; email: string } | null };

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
  // Who minted it. Tokens are personal, so this is the owning user.
  createdBy: z.object({ id: z.string(), name: z.string().nullable(), email: z.string() }).nullable(),
});
export type ApiTokenView = z.infer<typeof ApiTokenViewSchema>;

export const ApiTokenUseViewSchema = z.object({
  id: z.string(),
  at: z.date(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  action: z.string().nullable(),
  count: z.number().int(),
});
export type ApiTokenUseView = z.infer<typeof ApiTokenUseViewSchema>;

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
      include: { user: OWNER_SELECT },
    });
    await this.audit.log({ actor: userId, action: "api_token.create", target: t.id });
    return { token: raw, view: this.view(t) };
  }

  async list(userId: string): Promise<ApiTokenView[]> {
    const tokens = await this.prisma.apiToken.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { user: OWNER_SELECT },
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
      include: { user: OWNER_SELECT },
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
      include: { user: OWNER_SELECT },
    });
    // The history belonged to the retired secret; the new one starts clean (matches lastUsedAt: null).
    await this.prisma.apiTokenUse.deleteMany({ where: { tokenId: id } });
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

  /** Record one authorised call against a token: the newest rows only (bounded), identical back-to-back calls
   *  coalesced into a counter. Never receives the token — only the address/agent/action the guard derived. */
  async recordUse(tokenId: string, info: UseInfo): Promise<void> {
    const now = new Date();
    // Coalesce against ANY identical row inside the window, so a client alternating two tools does not flood the cap.
    const last = await this.prisma.apiTokenUse.findFirst({
      where: {
        tokenId,
        ip: info.ip,
        userAgent: info.userAgent,
        action: info.action,
        at: { gte: new Date(now.getTime() - COALESCE_WINDOW_MS) },
      },
      orderBy: { at: "desc" },
    });
    if (last) {
      await this.prisma.apiTokenUse.update({ where: { id: last.id }, data: { at: now, count: { increment: 1 } } });
      return;
    }
    await this.prisma.apiTokenUse.create({ data: { tokenId, at: now, ip: info.ip, userAgent: info.userAgent, action: info.action } });
    // Prune only once the table is actually over the cap.
    if ((await this.prisma.apiTokenUse.count({ where: { tokenId } })) <= MAX_USES_PER_TOKEN) return;
    const stale = await this.prisma.apiTokenUse.findMany({
      where: { tokenId },
      orderBy: { at: "desc" },
      skip: MAX_USES_PER_TOKEN,
      select: { id: true },
    });
    if (stale.length) await this.prisma.apiTokenUse.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
  }

  /** Recent use of one of the caller's OWN tokens (404 for anyone else's — never reveals it exists). */
  async listUses(userId: string, id: string): Promise<ApiTokenUseView[]> {
    const t = await this.prisma.apiToken.findFirst({ where: { id, userId }, select: { id: true } });
    if (!t) throw new NotFoundException("token not found");
    const rows = await this.prisma.apiTokenUse.findMany({
      where: { tokenId: id },
      orderBy: { at: "desc" },
      take: MAX_USES_PER_TOKEN,
    });
    return rows.map((r) => ({ id: r.id, at: r.at, ip: r.ip, userAgent: r.userAgent, action: r.action, count: r.count }));
  }

  private view(t: TokenRow): ApiTokenView {
    return {
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      scopes: t.scopes,
      expiresAt: t.expiresAt,
      lastUsedAt: t.lastUsedAt,
      createdAt: t.createdAt,
      createdBy: t.user ? { id: t.user.id, name: t.user.name, email: t.user.email } : null,
    };
  }
}

import { Injectable } from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { auditContext } from "./audit-context";

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string;
  meta?: Record<string, unknown>;
}

/** Filters shared by the team-scoped list and the per-resource list. */
export interface AuditFilters {
  action?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
}

export interface AuditView {
  id: string;
  actor: string; // resolved to email when the actor is a user, else raw (system/webhook…)
  action: string;
  target: string | null;
  meta: unknown;
  createdAt: Date;
}

const ADMIN: Role[] = [Role.OWNER, Role.ADMIN];
const PAGE = 100;

// Audit `meta` is free-form JSON written by many call sites; it must never carry a credential, but as
// defense-in-depth (the audit API is reachable by read-scoped PATs) these keys are stripped on read so a
// stray/legacy secret (e.g. a reset-link URL) can't be harvested. Keep it conservative + specific.
const SENSITIVE_META_KEYS = new Set(["token", "secret", "password", "apiToken", "resetUrl", "verifyUrl", "privateKey"]);
function sanitizeMeta(meta: unknown): unknown {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return meta;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (SENSITIVE_META_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface AuditPage {
  entries: AuditView[];
  nextCursor: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    // Stamp HOW the action was authorized (PAT + token id, or session) from the per-request context, so a reader
    // can tell a token's actions apart from a browser session's. `via`/`tokenId` survive the read-side sanitizer
    // (they are not secrets). A fire-and-forget log outside the request context simply records no `via`.
    const ctx = auditContext.getStore();
    const meta = ctx ? { ...(entry.meta ?? {}), via: ctx.via, ...(ctx.tokenId ? { tokenId: ctx.tokenId } : {}) } : entry.meta;
    await this.prisma.auditLog.create({
      data: {
        actor: entry.actor,
        action: entry.action,
        target: entry.target,
        ...(meta ? { meta: meta as Prisma.InputJsonValue } : {}),
      },
    });
  }

  /**
   * Audit entries the user may see. Team OWNER/ADMINs see actions by every
   * member of the selected team (actor-based scope); everyone else sees only
   * their own actions. No write-side teamId needed. Optional action/date filters.
   */
  async list(userId: string, teamId?: string, cursor?: string, filters?: Omit<AuditFilters, "cursor">): Promise<AuditPage> {
    const memberships = await this.prisma.membership.findMany({ where: { userId } });
    const adminTeams = new Set(memberships.filter((m) => ADMIN.includes(m.role)).map((m) => m.teamId));

    let actors: string[];
    if (teamId && adminTeams.has(teamId)) {
      const members = await this.prisma.membership.findMany({ where: { teamId } });
      actors = members.map((m) => m.userId);
    } else {
      actors = [userId];
    }

    return this.query({ actor: { in: actors }, ...this.filterWhere(filters) }, cursor);
  }

  /**
   * Audit entries for ONE resource (by target id), regardless of actor. Authorization is the caller's — the
   * resource controller must verify the user may see this resource before calling this. Optional action/date filters.
   */
  async listForTarget(targetId: string, filters?: AuditFilters): Promise<AuditPage> {
    return this.query({ target: targetId, ...this.filterWhere(filters) }, filters?.cursor);
  }

  private filterWhere(filters?: Omit<AuditFilters, "cursor">): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {};
    if (filters?.action) where.action = filters.action;
    if (filters?.from || filters?.to) {
      where.createdAt = { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) };
    }
    return where;
  }

  private async query(where: Prisma.AuditLogWhereInput, cursor?: string): Promise<AuditPage> {
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.actor))] } },
      select: { id: true, email: true },
    });
    const emailById = new Map(users.map((u) => [u.id, u.email]));

    const entries = rows.map((r) => ({
      id: r.id,
      actor: emailById.get(r.actor) ?? r.actor,
      action: r.action,
      target: r.target,
      meta: sanitizeMeta(r.meta),
      createdAt: r.createdAt,
    }));
    // A full page implies there may be older rows; the last id is the next cursor.
    const nextCursor = rows.length === PAGE ? rows[rows.length - 1].id : null;
    return { entries, nextCursor };
  }
}

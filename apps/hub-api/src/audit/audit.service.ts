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
// Export bounds. It is read in keyset batches (never one giant findMany) and stops at the FIRST of: the row
// ceiling, or the serialized byte budget — so a few members' oversized audit `meta` can't OOM the hub.
const EXPORT_MAX = 50_000; // hard row ceiling
const EXPORT_BATCH = 1_000; // rows per DB round-trip (bounds peak rows held at once)
const EXPORT_BYTE_BUDGET = 25_000_000; // ~25 MB of serialized output, whichever comes first
// A single audit row's `meta` is capped at write so one entry (e.g. a padded MCP tools/call `args`) can
// never bloat the table or an export; the auth stamps (via/tokenId) are kept, the bulk is dropped.
const META_MAX_BYTES = 16_384;

// Audit `meta` is free-form JSON written by many call sites; it must never carry a credential, but as
// defense-in-depth (the audit API is reachable by read-scoped PATs) these keys are stripped on read so a
// stray/legacy secret (e.g. a reset-link URL) can't be harvested. Keep it conservative + specific.
const SENSITIVE_META_KEYS = new Set(["token", "secret", "password", "apiToken", "resetUrl", "verifyUrl", "privateKey"]);
/** Cap one audit row's meta at write so a single entry (e.g. a padded MCP `args`) can't bloat the audit
 *  table or an export. Over the budget, keep only the auth stamps (via/tokenId) + a _truncated marker. */
function capMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return meta;
  if (JSON.stringify(meta).length <= META_MAX_BYTES) return meta;
  const kept: Record<string, unknown> = { _truncated: true };
  if ("via" in meta) kept.via = meta.via;
  if ("tokenId" in meta) kept.tokenId = meta.tokenId;
  return kept;
}

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
    const merged = ctx ? { ...(entry.meta ?? {}), via: ctx.via, ...(ctx.tokenId ? { tokenId: ctx.tokenId } : {}) } : entry.meta;
    const meta = capMeta(merged);
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
    const actors = await this.actorsFor(userId, teamId);
    return this.query({ actor: { in: actors }, ...this.filterWhere(filters) }, cursor);
  }

  /**
   * Export ALL audit entries the user may see (same actor-based team scope as `list`), as a single
   * unpaginated set for download/SIEM. Bounded by EXPORT_MAX: when more rows match, the NEWEST EXPORT_MAX
   * are returned and `truncated` is true (narrow the date range to get the rest). Pro-gated at the route.
   */
  async exportEntries(
    userId: string,
    teamId?: string,
    filters?: Omit<AuditFilters, "cursor">,
  ): Promise<{ entries: AuditView[]; truncated: boolean }> {
    const actors = await this.actorsFor(userId, teamId);
    const where: Prisma.AuditLogWhereInput = { actor: { in: actors }, ...this.filterWhere(filters) };
    const entries: AuditView[] = [];
    let bytes = 0;
    let cursor: string | undefined;
    let truncated = false;
    // Keyset-paginate: never hold more than EXPORT_BATCH raw rows at once, and stop at the first of the row
    // ceiling or the byte budget — so the peak memory is bounded regardless of how large any row's meta is.
    for (;;) {
      const rows = await this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: EXPORT_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;
      for (const v of await this.toViews(rows)) {
        if (entries.length >= EXPORT_MAX) { truncated = true; break; }
        const size = JSON.stringify(v).length + 2;
        if (entries.length > 0 && bytes + size > EXPORT_BYTE_BUDGET) { truncated = true; break; }
        entries.push(v);
        bytes += size;
      }
      if (truncated || rows.length < EXPORT_BATCH) break; // capped, or the table is exhausted
      cursor = rows[rows.length - 1].id;
    }
    return { entries, truncated };
  }

  /** The actors whose entries `userId` may see for an optional team: a team OWNER/ADMIN sees every member
   *  of that team; everyone else sees only their own. */
  private async actorsFor(userId: string, teamId?: string): Promise<string[]> {
    const memberships = await this.prisma.membership.findMany({ where: { userId } });
    const adminTeams = new Set(memberships.filter((m) => ADMIN.includes(m.role)).map((m) => m.teamId));
    if (teamId && adminTeams.has(teamId)) {
      const members = await this.prisma.membership.findMany({ where: { teamId } });
      return members.map((m) => m.userId);
    }
    return [userId];
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
    const entries = await this.toViews(rows);
    // A full page implies there may be older rows; the last id is the next cursor.
    const nextCursor = rows.length === PAGE ? rows[rows.length - 1].id : null;
    return { entries, nextCursor };
  }

  /** Resolve actor ids to emails and strip sensitive meta keys — the single read-side shaping for both the
   *  paginated list and the export, so they can never diverge on what a reader is allowed to see. */
  private async toViews(rows: { id: string; actor: string; action: string; target: string | null; meta: unknown; createdAt: Date }[]): Promise<AuditView[]> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.actor))] } },
      select: { id: true, email: true },
    });
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    return rows.map((r) => ({
      id: r.id,
      actor: emailById.get(r.actor) ?? r.actor,
      action: r.action,
      target: r.target,
      meta: sanitizeMeta(r.meta),
      createdAt: r.createdAt,
    }));
  }
}

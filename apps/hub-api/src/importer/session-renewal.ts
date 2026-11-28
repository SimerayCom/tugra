import { Logger } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";

/** How long an import session lives after its last action. */
export const SESSION_TTL_MS = 60 * 60_000;

const DEFAULT_MAX_HOURS = 12;
const MAX_HOURS_CEILING = 72;

/**
 * The longest an import session may live from the moment it was made, however often it is used. A session that is used keeps
 * living (each action moves its end to "now + 1 h"), but never past this, so a stored token or a read key cannot be kept alive for
 * ever by a page left open. `IMPORT_SESSION_MAX_HOURS` (1 to 72, default 12) changes it.
 */
export function sessionMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.IMPORT_SESSION_MAX_HOURS);
  const hours = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), MAX_HOURS_CEILING) : DEFAULT_MAX_HOURS;
  return hours * 3_600_000;
}

/** The last instant a session made at `createdAt` may be alive. */
export function sessionHardEnd(createdAt: Date | undefined, now: Date = new Date()): number {
  return (createdAt ?? now).getTime() + sessionMaxAgeMs();
}

export interface RenewableSession {
  id: string;
  status: string;
  expiresAt: Date;
  createdAt?: Date;
}

const logger = new Logger("ImportSessionRenewal");

/**
 * Sliding expiry: move the end of a live session to "now + 1 h", never past its hard end and never earlier than it is now. Only a
 * session that is still active and not yet over is touched (an ended or revoked session is never brought back), and nothing is written
 * while more than half of the hour is left, so a burst of calls is one write. Best effort: a failure here never fails the action that
 * called it. Returns whether the end moved.
 */
export async function renewImportSession(prisma: Pick<PrismaService, "importSession">, row: RenewableSession, now: Date = new Date()): Promise<boolean> {
  try {
    if (row.status !== "active" || row.expiresAt.getTime() <= now.getTime()) return false;
    if (row.expiresAt.getTime() - now.getTime() > SESSION_TTL_MS / 2) return false;
    const next = Math.min(now.getTime() + SESSION_TTL_MS, sessionHardEnd(row.createdAt, now));
    if (next <= row.expiresAt.getTime()) return false;
    const res = await prisma.importSession.updateMany({
      where: { id: row.id, status: "active", expiresAt: { gt: now, lt: new Date(next) } },
      data: { expiresAt: new Date(next), lastUsedAt: now },
    });
    return res.count > 0;
  } catch (e) {
    logger.warn(`session renewal skipped: ${e instanceof Error ? e.message : "unknown"}`);
    return false;
  }
}

/** Renew sessions by id (the run keeper's call): reads each row, then applies {@link renewImportSession}. Returns how many moved. */
export async function renewImportSessionsById(prisma: Pick<PrismaService, "importSession">, ids: readonly string[], now: Date = new Date()): Promise<number> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;
  try {
    const rows = await prisma.importSession.findMany({ where: { id: { in: unique }, status: "active", expiresAt: { gt: now } }, select: { id: true, status: true, expiresAt: true, createdAt: true } });
    let n = 0;
    for (const r of rows) if (await renewImportSession(prisma, r, now)) n++;
    return n;
  } catch (e) {
    logger.warn(`session renewal skipped: ${e instanceof Error ? e.message : "unknown"}`);
    return 0;
  }
}

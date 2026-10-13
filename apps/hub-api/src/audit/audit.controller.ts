import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { AuditService } from "./audit.service";

@ApiTags("audit")
@ApiSecurity("pat")
@Controller("audit")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class AuditController {
  constructor(private readonly svc: AuditService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query("teamId") teamId?: string,
    @Query("cursor") cursor?: string,
    @Query("action") action?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.svc.list(user.userId, str(teamId), str(cursor), { action: str(action), from: parseDate(from), to: parseDate(to) });
  }
}

/** Coerce a query value to a non-empty string, or undefined. The qs parser can turn `?k[op]=v` / repeated
 *  keys into an object/array; only a real string is a safe filter value (never a Prisma operator object). */
export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** A query-string date (ISO 8601 or epoch-ms); undefined when absent, non-string, or unparseable. */
export function parseDate(v: unknown): Date | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const d = new Date(/^\d+$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

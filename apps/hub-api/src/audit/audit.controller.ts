import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { RequireEdition, RequireEditionGuard } from "../common/edition";
import { AuditService, type AuditView } from "./audit.service";

/** The minimal Response surface the export needs — avoids pulling in @types/express (see the OAuth
 *  controllers' RedirectResponse for the same local-interface pattern). */
interface FileResponse {
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

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

  /**
   * Export the full (unpaginated) audit trail the caller may see, as CSV (default) or JSON, for SIEM /
   * compliance archival. PRO EDITION ONLY (RequireEditionGuard → 403 on Community). Same actor-based team
   * scope and the same read-side sanitizer as the list endpoint, so it can never reveal more than the UI.
   * Streaming a file, so it writes the Response directly (bypassing the JSON serializer). When the result is
   * capped at EXPORT_MAX rows the `X-Tugra-Audit-Truncated` header is `1` (narrow the date range for the rest).
   */
  @Get("export")
  @RequireEdition("pro")
  @UseGuards(RequireEditionGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // a heavy endpoint — cap repeats/parallel exports per caller
  async export(
    @Res() res: FileResponse,
    @CurrentUser() user: AuthUser,
    @Query("format") format?: string,
    @Query("teamId") teamId?: string,
    @Query("action") action?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<void> {
    const { entries, truncated } = await this.svc.exportEntries(user.userId, str(teamId), {
      action: str(action),
      from: parseDate(from),
      to: parseDate(to),
    });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("X-Tugra-Audit-Truncated", truncated ? "1" : "0");
    if (str(format) === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="tugra-audit-${stamp}.csv"`);
      res.send(toCsv(entries, truncated));
      return;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tugra-audit-${stamp}.json"`);
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), count: entries.length, truncated, entries }, null, 2));
  }
}

const CSV_COLUMNS: (keyof AuditView)[] = ["id", "createdAt", "actor", "action", "target", "meta"];

/** Serialize audit views to CSV. Quotes any cell with a comma/quote/newline (doubling embedded quotes), and
 *  neutralizes spreadsheet formula injection by prefixing a cell that starts with =, +, -, @ or a control
 *  char with a single quote — so a crafted action/target can't execute when the file is opened in Excel. */
export function toCsv(entries: AuditView[], truncated = false): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const e of entries) {
    rows.push(CSV_COLUMNS.map((c) => csvCell(e[c])).join(","));
  }
  // In-band marker so a CSV consumer that ignores the X-Tugra-Audit-Truncated header still sees the result
  // was capped (prefixed with ' so it is inert as a spreadsheet formula, same as csvCell would do).
  if (truncated) rows.push("'_truncated,,,,,result capped — narrow the date range for older rows");
  return rows.join("\r\n") + "\r\n";
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "string" ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // defuse CSV/formula injection before any quoting
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

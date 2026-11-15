import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity, ApiQuery } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { ApiZodResponse } from "../openapi/openapi";
import { isValidCron, minCronGapMs, nextRuns } from "../common/cron";

export const SchedulePreviewQuerySchema = z.object({
  cron: z.string().max(100),
  count: z.coerce.number().int().optional(),
});

export const SchedulePreviewSchema = z.object({
  valid: z.boolean(),
  error: z.string().optional(),
  timezone: z.string(),
  nextRuns: z.array(z.string()),
  minGapSeconds: z.number().nullable(),
});
export type SchedulePreview = z.infer<typeof SchedulePreviewSchema>;

/** Pure preview of a 5-field cron: validity, the next fires, and the tightest gap. Never 400s on a bad cron. */
export function previewSchedule(cron: string, count: number | undefined, from: Date = new Date()): SchedulePreview {
  // BullMQ sets no `tz` on repeat.pattern, so the hub process timezone is what a cron actually fires in.
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const n = Math.min(10, Math.max(1, count ?? 3));
  if (!/^\s*(\S+\s+){4}\S+\s*$/.test(cron) || !isValidCron(cron)) {
    return { valid: false, error: "not a valid 5-field cron expression", timezone, nextRuns: [], minGapSeconds: null };
  }
  const gap = minCronGapMs(cron, 24, from);
  return {
    valid: true,
    timezone,
    nextRuns: nextRuns(cron, n, from).map((d) => d.toISOString()),
    minGapSeconds: gap == null ? null : Math.round(gap / 1000),
  };
}

/** Read-scope helper for the schedule editor: shows when a cron will really fire (in the hub's timezone). */
@ApiTags("backups")
@ApiSecurity("pat")
@Controller("backup-schedules")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class SchedulePreviewController {
  @Get("preview")
  @ApiQuery({ name: "cron", required: true, type: String })
  @ApiQuery({ name: "count", required: false, type: Number, description: "1..10, default 3" })
  @ApiZodResponse(SchedulePreviewSchema)
  preview(@Query(new ZodValidationPipe(SchedulePreviewQuerySchema)) q: z.infer<typeof SchedulePreviewQuerySchema>): SchedulePreview {
    return previewSchedule(q.cron, q.count);
  }
}

import { z } from "zod";

export const DiskForecastRowSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  usedPct: z.number(),
  freeBytes: z.number(),
  growthBytesPerDay: z.number().nullable(),
  /** null = not filling up / not enough history; 0 = already full. */
  daysToFull: z.number().nullable(),
});

export const BackupDigestRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["database", "volume"]),
  resourceId: z.string(),
  resourceName: z.string(),
  status: z.enum(["PENDING", "RUNNING", "SUCCESS", "FAILED"]),
  createdAt: z.string(),
  sizeBytes: z.number().nullable(),
});

export const DeployDigestRowSchema = z.object({
  id: z.string(),
  appId: z.string(),
  appName: z.string(),
  status: z.enum(["QUEUED", "RUNNING", "SUCCESS", "FAILED", "CANCELLED"]),
  trigger: z.string().nullable(),
  createdAt: z.string(),
  durationMs: z.number().nullable(),
});

export const DashboardInsightsSchema = z.object({
  diskForecast: z.array(DiskForecastRowSchema),
  backups: z.object({
    windowDays: z.number(),
    ok: z.number(),
    failed: z.number(),
    running: z.number(),
    recent: z.array(BackupDigestRowSchema),
  }),
  deploys: z.array(DeployDigestRowSchema),
});
export type DashboardInsights = z.infer<typeof DashboardInsightsSchema>;

import { z } from "zod";

export const CreateMonitorSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["HTTP", "TCP", "METRIC"]),
    target: z.string().min(1).optional(),
    serverId: z.string().min(1).optional(),
    metric: z.enum(["DISK", "CPU", "MEM"]).optional(),
    thresholdPct: z.number().int().min(1).max(100).optional(),
    teamId: z.string().min(1),
    intervalSec: z.number().int().min(10).optional(),
    retries: z.number().int().min(0).optional(),
    timeoutMs: z.number().int().min(1000).optional(),
    resendEvery: z.number().int().min(0).optional(),
    channelIds: z.array(z.string()).optional(),
  })
  .refine(
    (d) =>
      d.type === "METRIC"
        ? !!d.serverId && !!d.metric && d.thresholdPct != null
        : !!d.target,
    {
      message:
        "HTTP/TCP need target; METRIC needs serverId, metric and thresholdPct",
      path: ["type"],
    },
  );
export type CreateMonitorInput = z.infer<typeof CreateMonitorSchema>;

export const UpdateMonitorSchema = z.object({
  name: z.string().min(1).optional(),
  intervalSec: z.number().int().min(10).optional(),
  retries: z.number().int().min(0).optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  resendEvery: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
  channelIds: z.array(z.string()).optional(),
});
export type UpdateMonitorInput = z.infer<typeof UpdateMonitorSchema>;

// Set the same notification channels on many monitors at once (fleet alert op).
// Each monitor receives only the channels that belong to its own team.
export const BulkMonitorChannelsSchema = z.object({
  monitorIds: z.array(z.string().min(1)).min(1),
  channelIds: z.array(z.string().min(1)).min(1),
});
export type BulkMonitorChannelsInput = z.infer<typeof BulkMonitorChannelsSchema>;

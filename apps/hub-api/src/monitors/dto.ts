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

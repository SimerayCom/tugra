import { z } from "zod";

export const CreateMonitorSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["HTTP", "TCP"]),
  target: z.string().min(1),
  teamId: z.string().min(1),
  intervalSec: z.number().int().min(10).optional(),
  retries: z.number().int().min(0).optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  resendEvery: z.number().int().min(0).optional(),
  channelIds: z.array(z.string()).optional(),
});
export type CreateMonitorInput = z.infer<typeof CreateMonitorSchema>;

import { z } from "zod";
import { isValidCron } from "../common/cron";

// 5-field cron (minute hour day-of-month month day-of-week). The regex fixes the SHAPE; `isValidCron` then
// rejects out-of-range fields (e.g. "0 25 * * *") that would otherwise persist and throw inside BullMQ at
// schedule time — which, in the boot loop, crash-loops the hub.
const cron = z
  .string()
  .regex(/^\s*(\S+\s+){4}\S+\s*$/, "must be a 5-field cron expression")
  .refine(isValidCron, "cron expression is not valid (check the field ranges)");

// Per-run timeout in seconds; null clears it back to the built-in default (300s). Bounded at 1h so a typo
// can't wedge a run for hours (mirrors the healthcheck timing caps).
const timeoutSec = z.number().int().min(1).max(3600).nullable().optional();

export const CreateTaskSchema = z.object({
  name: z.string().min(1).max(80),
  schedule: cron,
  command: z.string().min(1),
  enabled: z.boolean().optional(),
  timeoutSec,
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  schedule: cron.optional(),
  command: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  timeoutSec,
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

import { z } from "zod";

// 5-field cron (minute hour day-of-month month day-of-week).
const cron = z.string().regex(/^\s*(\S+\s+){4}\S+\s*$/, "must be a 5-field cron expression");

export const CreateTaskSchema = z.object({
  name: z.string().min(1).max(80),
  schedule: cron,
  command: z.string().min(1),
  enabled: z.boolean().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  schedule: cron.optional(),
  command: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

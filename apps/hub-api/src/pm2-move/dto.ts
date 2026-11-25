import { z } from "zod";
import { PM2_USER_RE } from "./pm2-facts";

const item = z.object({
  user: z.string().regex(PM2_USER_RE),
  name: z.string().min(1).max(120),
  /** Node major to use when the process names none (or to override what was found). */
  nodeMajor: z.number().int().min(10).max(30).optional(),
  /** Optional HTTP path the health check must see answer (below 500) after the port listens. */
  probePath: z
    .string()
    .regex(/^\/[A-Za-z0-9._~/-]{0,200}$/)
    .nullable()
    .optional(),
});

/** Preview: every process (no items) or the given ones with their choices. */
export const Pm2PlanSchema = z.object({ items: z.array(item).max(100).optional() });
export type Pm2PlanInput = z.infer<typeof Pm2PlanSchema>;

/** Move: each item carries the planHash of the preview the owner confirmed. */
export const Pm2MoveSchema = z.object({
  environmentId: z.string().min(1).optional(),
  items: z
    .array(item.extend({ planHash: z.string().regex(/^[0-9a-f]{64}$/) }))
    .min(1)
    .max(50),
});
export type Pm2MoveInput = z.infer<typeof Pm2MoveSchema>;

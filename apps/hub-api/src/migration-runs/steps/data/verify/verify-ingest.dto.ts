import { z } from "zod";
import { MAX_STATS_TABLES } from "./db-stats";

const Name = z.string().min(1).max(300);
const Count = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);

/**
 * The body of `POST /import/migration/verify` (what `tugra-agent migrate --verify` reports): the SOURCE side of DB logical
 * parity. Strict like every migration-token route (an unknown key is a 400, so a drifting migrator fails loudly), every
 * string is bounded and every number is an integer. It can carry no secret: names and counts only.
 */
export const VerifyItemSchema = z
  .object({
    itemRef: z.string().min(1).max(256),
    engine: z.string().regex(/^[A-Z]{3,16}$/),
    kind: z.enum(["tables", "keys"]),
    mode: z.enum(["exact", "estimate"]),
    state: z.enum(["measured", "skipped", "failed"]),
    reason: z
      .string()
      .max(64)
      .regex(/^[a-zA-Z0-9 _.:/-]*$/)
      .optional(),
    tableCount: z.number().int().min(0).max(10_000_000),
    truncated: z.boolean().optional(),
    tables: z
      .array(z.object({ name: Name, rows: Count, estimated: z.boolean().optional(), expires: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict())
      .max(MAX_STATS_TABLES),
  })
  .strict();
export type VerifyItem = z.infer<typeof VerifyItemSchema>;

export const VerifyBodySchema = z.object({ items: z.array(VerifyItemSchema).min(1).max(500) }).strict();
export type VerifyBody = z.infer<typeof VerifyBodySchema>;

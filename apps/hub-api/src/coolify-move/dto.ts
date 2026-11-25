import { z } from "zod";

export const StatusQuerySchema = z.object({ teamId: z.string().min(1).max(64) }).strict();
export type StatusQuery = z.infer<typeof StatusQuerySchema>;

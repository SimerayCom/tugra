import { z } from "zod";

export const ServerParamSchema = z.object({ serverId: z.string().min(1) });

/** Opting a server in is a deliberate act: the caller must say so. */
export const EnableSchema = z.object({ confirm: z.literal(true) });
export type EnableInput = z.infer<typeof EnableSchema>;

export const ListQuerySchema = z.object({ teamId: z.string().min(1) });
export type ListQuery = z.infer<typeof ListQuerySchema>;

/** Which Tugra team each chosen Coolify server goes to. */
export const GenerateSchema = z.object({
  assignments: z
    .array(z.object({ coolifyServerId: z.string().min(1).max(40), teamId: z.string().min(1) }))
    .min(1)
    .max(200),
});
export type GenerateInput = z.infer<typeof GenerateSchema>;

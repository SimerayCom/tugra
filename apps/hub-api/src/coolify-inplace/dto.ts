import { z } from "zod";

const Id = z.string().min(1).max(64);
const ItemRef = z.string().regex(/^(app|service):[\x21-\x7e]{1,280}$/, "invalid item ref");

/**
 * `POST /coolify-inplace/plan`: read what Coolify runs on a server and which Tugra app each container belongs to. `opId` is the import op that
 * created the apps. `rebuild` lists the apps to build with Tugra and verify instead of reusing Coolify's image (only for apps that do not share
 * writable data with Coolify's copy).
 */
export const PlanSchema = z.object({ serverId: Id, opId: Id, rebuild: z.array(ItemRef).max(500).default([]) }).strict();
export type PlanInput = z.infer<typeof PlanSchema>;

/** The owner types the server's name to take its ports (swap) or to give them back. */
export const SwapSchema = z.object({ confirm: z.string().trim().min(1).max(253) }).strict();
export type SwapInput = z.infer<typeof SwapSchema>;
export const GiveBackSchema = SwapSchema;
export type GiveBackInput = SwapInput;

export const ListQuerySchema = z.object({ serverId: Id }).strict();
export type ListQuery = z.infer<typeof ListQuerySchema>;

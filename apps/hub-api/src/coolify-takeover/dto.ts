import { z } from "zod";
import { COOLIFY_SECRET_CLASSES, COOLIFY_SECRETS_GRANT_MAX_HOURS } from "@tugra/shared";

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

/** Consent to the sealed secret read (lane B). `confirm` is the Coolify host's name, typed by the owner. `classes` omitted = every tier-1 class. */
export const SecretsGrantSchema = z.object({
  serverId: z.string().min(1).max(60),
  classes: z.array(z.enum(COOLIFY_SECRET_CLASSES)).min(1).max(COOLIFY_SECRET_CLASSES.length).optional(),
  hours: z.number().int().min(1).max(COOLIFY_SECRETS_GRANT_MAX_HOURS).optional(),
  confirm: z.string().min(1).max(200),
});
export type SecretsGrantInput = z.infer<typeof SecretsGrantSchema>;

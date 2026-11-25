import { z } from "zod";
import { COOLIFY_SECRET_CLASSES, COOLIFY_SECRETS_GRANT_MAX_HOURS } from "@tugra/shared";
import { COOLIFY_SSH_UUID_RE } from "@tugra/shared";

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

/**
 * Install the Tugra agent on Coolify's other servers over Coolify's own SSH keys (lane C). `confirm` is the typed number of servers: the
 * owner's explicit consent for exactly that many. The uuids are Coolify's own ids and are checked against the stored inventory too.
 */
const SshUuidSchema = z.string().regex(COOLIFY_SSH_UUID_RE);
export const SshStartSchema = z.object({
  coolifyServerUuids: z.array(SshUuidSchema).min(1).max(100),
  teamId: z.string().min(1),
  confirm: z.string().min(1).max(4),
  concurrency: z.number().int().min(1).max(8).optional(),
});
export type SshStartInput = z.infer<typeof SshStartSchema>;

export const SshConfirmSchema = z.object({
  confirm: z.string().min(1).max(4),
  coolifyServerUuids: z.array(SshUuidSchema).min(1).max(100).optional(),
});
export type SshConfirmInput = z.infer<typeof SshConfirmSchema>;

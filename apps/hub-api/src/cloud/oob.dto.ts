import { z } from "zod";
import { OOB_POWER_ACTIONS } from "./providers/cloud-provider.interface";

/** The power actions whose effect is a stop or a hard cut: they need the server's name typed as confirmation. */
export const OOB_DESTRUCTIVE_POWER_ACTIONS = ["power_off", "reboot", "shutdown"] as const;

// `reboot` is a HARD reset (power cut and started again), `power_off` cuts power, `shutdown` is the graceful stop.
export const OobPowerSchema = z
  .object({
    action: z.enum(OOB_POWER_ACTIONS),
    // Required (and compared with the server's name in the service) for power_off / reboot / shutdown.
    confirmName: z.string().min(1).max(200).optional(),
  })
  .strict();
export type OobPowerInput = z.infer<typeof OobPowerSchema>;

export const OobLinkSchema = z
  .object({
    cloudCredentialId: z.string().min(1),
    providerServerId: z.string().regex(/^[1-9]\d{0,18}$/, "must be the provider's numeric server id"),
    // Needed only when the provider server's public IPv4 cannot be matched to this server's: type the provider
    // server's name to say "yes, this is the machine".
    confirmProviderName: z.string().min(1).max(200).optional(),
  })
  .strict();
export type OobLinkInput = z.infer<typeof OobLinkSchema>;

const ProviderActionSchema = z.object({ id: z.string(), status: z.enum(["running", "success", "error"]), command: z.string() });

const ProviderStateSchema = z.object({
  providerServerId: z.string(),
  name: z.string(),
  status: z.string(),
  locked: z.boolean(),
  rescueEnabled: z.boolean(),
  publicIpv4: z.string().nullable(),
  publicIpv6: z.string().nullable(),
});

export const OobStatusSchema = z.object({
  linked: z.boolean(),
  provider: z.string().nullable(),
  providerServerId: z.string().nullable(),
  /** true = linked by hand (Tugra did not create the VM and never destroys it). */
  manual: z.boolean(),
  /** The linked provider has an out-of-band client (Hetzner today). */
  supported: z.boolean(),
  credentialName: z.string().nullable(),
  /** The server still names a provider VM but its credential was deleted: link it again. */
  credentialMissing: z.boolean(),
  canManage: z.boolean(),
  canOps: z.boolean(),
  state: ProviderStateSchema.nullable(),
  /** Why the live provider state could not be read (the link itself is fine). */
  stateError: z.string().nullable(),
});
export type OobStatusView = z.infer<typeof OobStatusSchema>;

export const OobActionResultSchema = z.object({
  ok: z.literal(true),
  action: z.string(),
  providerAction: ProviderActionSchema,
});
export type OobActionResult = z.infer<typeof OobActionResultSchema>;

/** Returned ONCE; never stored, logged or audited. */
export const OobRescueResultSchema = OobActionResultSchema.extend({
  rootPassword: z.string(),
  /** Rescue boots on the next (re)boot and switches itself off after that boot or after this many minutes. */
  expiresInMinutes: z.number(),
});
export type OobRescueResult = z.infer<typeof OobRescueResultSchema>;

/** Returned ONCE; never stored, logged or audited. */
export const OobConsoleResultSchema = OobActionResultSchema.extend({
  wssUrl: z.string(),
  password: z.string(),
  validForSeconds: z.number(),
});
export type OobConsoleResult = z.infer<typeof OobConsoleResultSchema>;

export const OobCandidateSchema = ProviderStateSchema.extend({
  /** The provider server's public IPv4 equals this server's: the safe pick. */
  matchesIp: z.boolean(),
  /** Already linked to another Tugra server in this team. */
  taken: z.boolean(),
});
export const OobCandidatesSchema = z.array(OobCandidateSchema);
export type OobCandidate = z.infer<typeof OobCandidateSchema>;

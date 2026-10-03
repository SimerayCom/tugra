import { z } from "zod";

/** Create a team-scoped DNS-provider credential (one-click custom-domain auto-setup). v1: Cloudflare only.
 *  `apiToken` is write-only — verified against the provider then encrypted; never returned. */
export const CreateDnsCredentialSchema = z.object({
  teamId: z.string().min(1),
  name: z.string().min(1),
  provider: z.enum(["cloudflare"]), // only cloudflare has a client in v1
  apiToken: z.string().min(1),
  cfAccountId: z.string().min(1).optional(),
});
export type CreateDnsCredentialInput = z.infer<typeof CreateDnsCredentialSchema>;

/** Update a DNS credential. `apiToken` is write-only: only re-verified + re-encrypted when supplied. */
export const UpdateDnsCredentialSchema = z.object({
  name: z.string().min(1).optional(),
  apiToken: z.string().min(1).optional(),
  cfAccountId: z.string().min(1).nullable().optional(),
});
export type UpdateDnsCredentialInput = z.infer<typeof UpdateDnsCredentialSchema>;

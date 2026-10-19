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

/** Preview or apply the mail-deliverability DNS records (MX/SPF/DMARC/DKIM) for a domain, via a team DNS
 *  credential. The record values themselves are derived server-side (buildMailDnsRecords); the body only supplies
 *  the domain, the mail host, an optional DKIM key the mail server generated, and the DMARC knobs. `overwrite`
 *  opts into replacing an existing (foreign) mail record instead of surfacing it as a conflict. */
export const MailDnsRequestSchema = z.object({
  credentialId: z.string().min(1),
  domain: z.string().min(1),
  mailHost: z.string().min(1),
  dkim: z.object({ selector: z.string().min(1), publicKey: z.string().min(1) }).optional(),
  dmarcPolicy: z.enum(["none", "quarantine", "reject"]).optional(),
  dmarcReportTo: z.string().min(1).optional(),
  overwrite: z.boolean().optional(),
});
export type MailDnsRequestInput = z.infer<typeof MailDnsRequestSchema>;

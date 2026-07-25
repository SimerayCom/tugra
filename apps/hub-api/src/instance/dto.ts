import { z } from "zod";
import { isValidIpOrCidr } from "../common/ip-allowlist";

/**
 * Owner patch for instance-level settings. Covers the API-gating fields plus the onboarding basics
 * (public URL + ACME email). Each allowlist entry must be a valid single IP or `addr/prefix` CIDR
 * (empties are dropped by the controller, never persisted) — the refine rejects garbage with a 400
 * instead of silently saving it. `publicUrl`/`acmeEmail` are `.nullable()` so the owner can CLEAR them:
 * the onboarding form submits "" to clear, which the controller maps to null (a bare `.url()`/`.email()`
 * would reject "" with a 400, making a field impossible to unset).
 */
export const UpdateInstanceSettingsSchema = z.object({
  apiEnabled: z.boolean().optional(),
  apiAllowedIps: z
    .array(z.string().trim())
    .optional()
    .refine((a) => a === undefined || a.every((e) => e === "" || isValidIpOrCidr(e)), {
      message: "each entry must be a valid IP address or CIDR range",
    }),
  publicUrl: z.union([z.string().url(), z.literal("")]).nullable().optional(),
  acmeEmail: z.union([z.string().email(), z.literal("")]).nullable().optional(),
});
export type UpdateInstanceSettingsInput = z.infer<typeof UpdateInstanceSettingsSchema>;

/**
 * Owner patch for the self-update preferences (channel + auto-update). Both optional (partial patch).
 * `updateChannel` is constrained to the user-selectable published channels — an unknown channel would
 * silently never resolve a manifest entry, so we reject it here rather than store it.
 */
export const UpdateInstanceUpdateSchema = z.object({
  autoUpdate: z.boolean().optional(),
  updateChannel: z.enum(["stable", "beta"]).optional(),
});
export type UpdateInstanceUpdateInput = z.infer<typeof UpdateInstanceUpdateSchema>;

// A DNS domain used for OIDC JIT provisioning (email-suffix match): labels of letters/digits/hyphens
// separated by dots, at least one dot. Rejects garbage (spaces, `@`, schemes) with a 400.
const domainRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Owner patch for OIDC single sign-on (Pro edition). All optional (partial patch). `oidcIssuer`/
 * `oidcClientId` are `.nullable()` + accept "" so the owner can clear them (the controller maps "" → null).
 * `oidcClientSecret` is write-only: when a non-empty value is supplied it is encrypted and stored; when
 * omitted (or "") the existing secret is preserved — it is never returned in any view. `oidcAllowedDomains`
 * restricts JIT provisioning to those email domains (empty = no restriction).
 */
export const OidcConfigSchema = z.object({
  oidcEnabled: z.boolean().optional(),
  oidcIssuer: z.union([z.string().url(), z.literal("")]).nullable().optional(),
  oidcClientId: z.union([z.string().trim().min(1), z.literal("")]).nullable().optional(),
  oidcClientSecret: z.string().optional(),
  oidcAllowedDomains: z
    .array(z.string().trim())
    .optional()
    .refine((a) => a === undefined || a.every((d) => d === "" || domainRe.test(d)), {
      message: "each entry must be a valid domain name (e.g. company.com)",
    }),
});
export type OidcConfigInput = z.infer<typeof OidcConfigSchema>;

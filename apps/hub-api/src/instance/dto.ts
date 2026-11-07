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

/**
 * Owner action to activate (or clear) a signed license. A non-empty token is verified before it is stored;
 * an empty string clears the license (downgrades to the env/community edition). The token itself is
 * signature-protected, so storing it is safe.
 */
export const LicenseSchema = z.object({
  token: z.string(),
});
export type LicenseInput = z.infer<typeof LicenseSchema>;

/**
 * Owner toggle for anonymous usage stats (on by default, opt-out). Only the owner-UI switch is settable
 * here; the deployment-level env hard-off (TUGRA_TELEMETRY=0) is NOT owner-settable and overrides this.
 */
export const UpdateTelemetrySchema = z.object({
  enabled: z.boolean(),
});
export type UpdateTelemetryInput = z.infer<typeof UpdateTelemetrySchema>;

// White-label branding (Pro). All optional (partial patch) and clearable with "" → the controller maps a
// falsy value to null (back to the Tugra default for that field). URLs are http(s) only and the accent is a
// #rrggbb hex, so a crafted value can't inject a `javascript:` logo src or break out of the CSS variable.
const brandUrl = z.string().max(2048).refine((u) => u === "" || /^https?:\/\//i.test(u), "must be an http(s) URL");
const brandColor = z.string().refine((c) => c === "" || /^#[0-9a-fA-F]{6}$/.test(c), "must be a #rrggbb hex color");
export const UpdateBrandingSchema = z.object({
  name: z.string().trim().max(40).nullable().optional(),
  logoUrl: brandUrl.nullable().optional(),
  faviconUrl: brandUrl.nullable().optional(),
  accentColor: brandColor.nullable().optional(),
  hidePoweredBy: z.boolean().optional(),
});
export type UpdateBrandingInput = z.infer<typeof UpdateBrandingSchema>;

// Outbound mail (in-panel Email settings). All optional (partial patch); "" clears a text field (the service
// maps it to null). `from` is a bare address or `Name <address>` with NO CR/LF (blocks header injection).
// `password` / `resendKey` are WRITE-ONLY: a non-empty value is encrypted + stored, a blank/omitted one keeps
// the stored secret — neither is ever returned in any view.
const mailFrom = z
  .string()
  .max(320)
  .refine((v) => v === "" || /^(?:[^<>\r\n]*<[^<>@\s]+@[^<>@\s]+>|[^<>@\s]+@[^<>@\s]+)$/.test(v.trim()), "must be an email address or Name <address>");
const mailHost = z
  .string()
  .max(255)
  .refine((v) => v === "" || /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(v.trim()), "must be a hostname");
export const MAIL_PROVIDERS = ["none", "smtp", "resend"] as const;
export const UpdateMailSettingsSchema = z.object({
  provider: z.enum(MAIL_PROVIDERS).optional(),
  host: mailHost.nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  secure: z.boolean().optional(),
  user: z.string().max(255).nullable().optional(),
  from: mailFrom.nullable().optional(),
  password: z.string().max(1024).optional(),
  resendKey: z.string().max(1024).optional(),
});
export type UpdateMailSettingsInput = z.infer<typeof UpdateMailSettingsSchema>;

/** Owner action: send a test email to `to` using the EFFECTIVE mail config. */
export const MailTestSchema = z.object({
  to: z.string().trim().email().max(320),
});
export type MailTestInput = z.infer<typeof MailTestSchema>;

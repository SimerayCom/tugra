import { z } from "zod";

/** An http(s) URL for an operator-supplied external store address (mirrors the importer's baseUrl). Capped
 *  so a huge value can't bloat the row / URL; an SSRF guard (loopback/metadata) is applied at use time. */
const HttpUrl = z
  .string()
  .min(1)
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), { message: "address must be an http(s) URL" });

/** Create a team-scoped external secret-store provider. v1: HashiCorp Vault only. `token` is write-only —
 *  verified against the store then encrypted; never returned. (Lengths capped to bound row/URL/log size.) */
export const CreateSecretProviderSchema = z.object({
  teamId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  kind: z.enum(["vault"]), // only vault has a client in v1
  address: HttpUrl,
  token: z.string().min(1).max(8192), // Vault tokens / JWTs can be long
});
export type CreateSecretProviderInput = z.infer<typeof CreateSecretProviderSchema>;

/** Update a secret provider. `token` is write-only: only re-verified + re-encrypted when supplied. `kind`
 *  is immutable (a different store is a different provider). */
export const UpdateSecretProviderSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  address: HttpUrl.optional(),
  token: z.string().min(1).max(8192).optional(),
});
export type UpdateSecretProviderInput = z.infer<typeof UpdateSecretProviderSchema>;

/** Bind an external secret to an app's runtime env: fetch `remoteKey` from `providerId` at deploy time and
 *  inject it under `envVar`. The value is never stored. `remoteKey` is a provider-specific locator (Vault:
 *  "<mount>/<path>#<field>"), validated against the provider's kind when the ref is created. */
export const CreateSecretRefSchema = z.object({
  providerId: z.string().min(1).max(64),
  envVar: z.string().min(1).max(128), // the service additionally enforces the strict env-key policy
  remoteKey: z.string().min(1).max(512),
});
export type CreateSecretRefInput = z.infer<typeof CreateSecretRefSchema>;

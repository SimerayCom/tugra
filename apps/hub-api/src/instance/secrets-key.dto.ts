import { z } from "zod";

/** A data key id: the 16-hex fingerprint carried in every `tk1.<keyId>.` ciphertext. */
export const SECRETS_KEY_ID_RE = /^[0-9a-f]{16}$/;

/**
 * Rotate the secrets encryption key. `expectedCurrentKeyId` is a compare-and-set against the key the caller saw
 * (a stale page gets 409 stale_current instead of rotating twice). `new-key` makes a fresh random data key active;
 * `env-root` demotes the active data key so the .env key encrypts again (the downgrade escape hatch).
 */
export const RotateSecretsKeySchema = z
  .object({
    expectedCurrentKeyId: z.string().regex(SECRETS_KEY_ID_RE),
    target: z.enum(["new-key", "env-root"]).default("new-key"),
    reencrypt: z.boolean().default(true),
  })
  .strict();
export type RotateSecretsKeyInput = z.infer<typeof RotateSecretsKeySchema>;

export const SecretsKeyIdParamSchema = z.string().regex(SECRETS_KEY_ID_RE);

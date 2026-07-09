import { z } from "zod";

/**
 * Environment schema. The hub FAILS CLOSED — it will not boot with missing or
 * weak security-critical config (no insecure defaults, ever).
 */
function isBase64Seed32(s: string): boolean {
  try {
    return Buffer.from(s, "base64").length === 32;
  } catch {
    return false;
  }
}

export const envSchema = z
  .object({
  // No default: an UNSET NODE_ENV is treated as production below (fail closed),
  // so a prod deploy that forgets to set it still requires HUB_SIGNING_KEY.
  NODE_ENV: z.enum(["development", "production", "test"]).optional(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  HUB_PORT: z.coerce.number().int().positive().default(3000),
  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET must be at least 16 chars"),
  JWT_REFRESH_SECRET: z.string().min(16, "JWT_REFRESH_SECRET must be at least 16 chars"),
  SECRETS_ENCRYPTION_KEY: z.string().min(16, "SECRETS_ENCRYPTION_KEY must be at least 16 chars"),
  // The hub's ed25519 command-signing identity (base64 32-byte seed). Optional in
  // dev/test (an ephemeral key is generated), but REQUIRED in production so the
  // identity is stable across restarts and consistent across instances.
  HUB_SIGNING_KEY: z
    .string()
    .refine(isBase64Seed32, "HUB_SIGNING_KEY must be a base64-encoded 32-byte ed25519 seed")
    .optional(),
  ACME_EMAIL: z.string().email().optional(), // Let's Encrypt account email (deploy SSL)
  // Public base URL the agent dials back to (e.g. https://hub.example.com). Used to
  // build the install command; falls back to the request Host when unset.
  HUB_PUBLIC_URL: z.string().url().optional(),
  // Optional, opt-in: enables AI deploy-log analysis (logs are sent to Anthropic).
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).optional(),
  // Optional, opt-in: "Sign in with GitHub". When unset, the OAuth routes return
  // a friendly "unconfigured" redirect and the app boots normally.
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  // Web origin the OAuth callback hands tokens back to (the SPA).
  WEB_PUBLIC_URL: z.string().url().default("http://localhost:3001"),
  // Set to "true" only when the hub sits behind a trusted reverse proxy, so the
  // observed agent source IP is read from X-Forwarded-For instead of the (proxy)
  // TCP peer. Off by default — the raw peer address cannot be spoofed by agents.
  HUB_TRUSTED_PROXY: z.enum(["true", "false"]).optional(),
  // Base domain for generated sslip.io-style magic domains. Overridable to nip.io
  // (or a self-hosted wildcard) if sslip.io is blocked; per-server magicSuffix wins.
  MAGIC_DOMAIN_SUFFIX: z.string().min(1).default("sslip.io"),
  })
  // Fail closed: a stable command-signing identity is required anywhere that is
  // not EXPLICITLY development or test — including an unset NODE_ENV — so a live
  // hub never silently falls back to an ephemeral key.
  .superRefine((v, ctx) => {
    const lenient = v.NODE_ENV === "development" || v.NODE_ENV === "test";
    if (!lenient && !v.HUB_SIGNING_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["HUB_SIGNING_KEY"],
        message: "HUB_SIGNING_KEY is required unless NODE_ENV is development or test (fail-closed)",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

import { z } from "zod";

/**
 * Environment schema. The hub FAILS CLOSED — it will not boot with missing or
 * weak security-critical config (no insecure defaults, ever).
 */
export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  HUB_PORT: z.coerce.number().int().positive().default(3000),
  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET must be at least 16 chars"),
  JWT_REFRESH_SECRET: z.string().min(16, "JWT_REFRESH_SECRET must be at least 16 chars"),
  SECRETS_ENCRYPTION_KEY: z.string().min(16, "SECRETS_ENCRYPTION_KEY must be at least 16 chars"),
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

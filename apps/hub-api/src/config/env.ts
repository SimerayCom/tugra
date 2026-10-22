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

/** A base64-encoded ed25519 SPKI DER public key is exactly 44 bytes. */
function isBase64Ed25519Spki(s: string): boolean {
  try {
    return Buffer.from(s, "base64").length === 44;
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
  // Optional: overrides the agent image the `/install/agent.sh` bootstrap pulls (custom registry /
  // air-gapped mirror). Defaults to the version-matched `ghcr.io/simeraycom/tugra-agent:<hub version>`.
  AGENT_IMAGE: z.string().min(1).optional(),
  // Optional, opt-in: "Sign in with GitHub". When unset, the OAuth routes return
  // a friendly "unconfigured" redirect and the app boots normally.
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  // Web origin the OAuth callback hands tokens back to (the SPA).
  WEB_PUBLIC_URL: z.string().url().default("http://localhost:3001"),
  // Optional first-run claim code. When set AND the instance is not yet initialized, the FIRST account can
  // only be created with the matching code — so on a freshly installed box reachable on a LAN/public IP,
  // a random visitor can't claim the owner account before you do. Irrelevant once initialized; unset = off
  // (dev/e2e/existing installs behave exactly as before). Generated + printed by scripts/install.sh.
  SETUP_CODE: z.string().min(1).optional(),
  // Turnkey single-box install only: the enroll token the bundled local agent uses. When set, the first
  // owner registration auto-provisions the local box as the "This machine" server so no
  // agent command is pasted. Unset everywhere else (manual/remote enrollment unchanged). FAIL CLOSED on a
  // weak value: the enroll endpoint authenticates an agent by this token alone, so a guessable one would let
  // a rogue agent claim "This machine" during the enrollment window. install.sh generates a 48-char hex token.
  LOCAL_AGENT_ENROLL_TOKEN: z
    .string()
    .min(32, "LOCAL_AGENT_ENROLL_TOKEN must be at least 32 chars — a high-entropy enroll token, not a guessable value")
    .optional(),
  // Turnkey single-box install only: the host's real public IP, best-effort-detected by install.sh. When set,
  // provisionLocalServer pins it on "This machine" (ipSource="manual") so deployed app URLs are reachable from
  // outside — without it the hub would fall back to the agent's in-container docker-bridge address. Optional;
  // a blank/private/garbage value is ignored (re-validated with isPublicIp before it is used).
  LOCAL_SERVER_PUBLIC_IP: z.string().optional(),
  // The uiMode new accounts get by default. A turnkey single-box install sets "home" so the owner lands on
  // the launcher; unset → "home"/"fleet" falls back to the schema default ("fleet").
  DEFAULT_UI_MODE: z.enum(["fleet", "home"]).optional(),
  // Set to "true" only when the hub sits behind a trusted reverse proxy, so the
  // observed agent source IP is read from X-Forwarded-For instead of the (proxy)
  // TCP peer. Off by default — the raw peer address cannot be spoofed by agents.
  HUB_TRUSTED_PROXY: z.enum(["true", "false"]).optional(),
  // Product edition (open-core): "community" (OSS, default) | "pro" | "cloud". Build/license-injected,
  // not owner-settable. Validated here for fail-fast boot; @tugra/shared also normalises it defensively.
  TUGRA_EDITION: z.enum(["community", "pro", "cloud"]).default("community"),
  // Allow notification channels (webhook/ntfy/gotify/smtp) to target private LAN addresses
  // (RFC1918/CGNAT/ULA). Off by default — a self-hoster running an internal ntfy/gotify/SMTP sets
  // this to "true". Cloud-metadata (169.254.169.254), loopback and link-local stay blocked regardless.
  NOTIFY_ALLOW_PRIVATE_TARGETS: z.enum(["true", "false"]).default("false"),
  // Collapse duplicate notifications: within this many seconds, a repeat of the SAME (channel, event,
  // entity) GENERAL alert is suppressed — throttles a resource that fails repeatedly (a deploy/backup
  // failing every run). 0 disables it. Monitor up/down are EXEMPT (the monitor runner's state machine +
  // resendEvery are their authoritative throttle, and a time window would drop real re-alerts / a re-DOWN
  // after recovery); events without a unique entity id are never deduped.
  NOTIFY_DEDUPE_WINDOW_SEC: z.coerce.number().int().nonnegative().default(60),
  // Base domain for generated sslip.io-style magic domains. Overridable to nip.io
  // (or a self-hosted wildcard) if sslip.io is blocked; per-server magicSuffix wins.
  MAGIC_DOMAIN_SUFFIX: z.string().min(1).default("sslip.io"),
  // Transactional email (password reset, email verification, team invites). All optional:
  // when MAIL_HOST is unset the mailer is fail-soft (no email is sent, flows still work).
  MAIL_HOST: z.string().min(1).optional(),
  MAIL_PORT: z.coerce.number().int().positive().default(587),
  MAIL_SECURE: z.enum(["true", "false"]).default("false"),
  MAIL_USER: z.string().min(1).optional(),
  MAIL_PASS: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(1).default("Tugra <no-reply@localhost>"),
  // When true, unverified users are blocked from write actions after login. Off by default
  // (self-host convenience); not wired to email verification yet.
  REQUIRE_EMAIL_VERIFICATION: z.enum(["true", "false"]).default("false"),
  // Retention: the hourly prune deletes raw metric/container-metric rows older than this many hours
  // (UI charts range up to 24h; long-range history comes from 1-minute rollups), and non-important
  // heartbeats older than this many days. Rollups (the source for >2h ranges up to 7d) are kept for
  // METRICS_ROLLUP_RETENTION_DAYS.
  METRICS_RAW_RETENTION_HOURS: z.coerce.number().int().positive().default(48),
  HEARTBEAT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  METRICS_ROLLUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  // Host-port range the install-time allocator draws from when a template needs a published port.
  TUGRA_HOSTPORT_MIN: z.coerce.number().int().positive().default(20000),
  TUGRA_HOSTPORT_MAX: z.coerce.number().int().positive().default(45000),
  // Optional, opt-in: a signed remote template catalog. When CATALOG_SOURCE_URL is set the hub
  // periodically fetches it, verifies the ed25519 signature against CATALOG_PUBLISHER_KEY, and
  // overlays it onto the bundled catalog (offline-fallback to bundled when unset/unreachable/invalid).
  CATALOG_SOURCE_URL: z.string().url().optional(),
  CATALOG_PUBLISHER_KEY: z
    .string()
    .refine(isBase64Ed25519Spki, "CATALOG_PUBLISHER_KEY must be a base64-encoded ed25519 SPKI DER public key")
    .optional(),
  CATALOG_SYNC_INTERVAL_MIN: z.coerce.number().int().positive().default(60),
  // Optional, opt-in: the self-update version check. When UPDATE_MANIFEST_URL is set the hub
  // periodically fetches the signed release manifest (versions.json + a detached versions.json.sig),
  // verifies the ed25519 signature against UPDATE_PUBLISHER_KEY, and caches the latest published
  // version so the owner sees an "update available" status. Never applies anything (report-only).
  UPDATE_MANIFEST_URL: z.string().url().optional(),
  UPDATE_PUBLISHER_KEY: z
    .string()
    .refine(isBase64Ed25519Spki, "UPDATE_PUBLISHER_KEY must be a base64-encoded ed25519 SPKI DER public key")
    .optional(),
  UPDATE_CHECK_INTERVAL_MIN: z.coerce.number().int().positive().default(1440), // daily
  UPDATE_CHANGELOG_URL: z.string().url().optional(),
  // Signed-license entitlement. TUGRA_LICENSE is an optional signed license (EdDSA JWT) that unlocks the
  // Pro/Cloud edition — verified against Tugra's license public key, which is COMPILED IN (see
  // license/license-key.ts), NOT taken from the environment (an env-sourced trust anchor would let an
  // operator substitute their own key and self-sign). TUGRA_LICENSE_PUBLISHER_KEY is a DEV/TEST-ONLY key
  // override for local testing; it is ignored in production, so it can never be used to forge a license.
  TUGRA_LICENSE_PUBLISHER_KEY: z
    .string()
    .refine(isBase64Ed25519Spki, "TUGRA_LICENSE_PUBLISHER_KEY must be a base64-encoded ed25519 SPKI DER public key")
    .optional(),
  TUGRA_LICENSE: z.string().min(1).optional(),
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
    if (v.TUGRA_HOSTPORT_MIN >= v.TUGRA_HOSTPORT_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TUGRA_HOSTPORT_MAX"],
        message: "TUGRA_HOSTPORT_MAX must be greater than TUGRA_HOSTPORT_MIN",
      });
    }
    // Fail closed: never sync an UNSIGNED remote catalog — a source URL requires a publisher key.
    if (v.CATALOG_SOURCE_URL && !v.CATALOG_PUBLISHER_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CATALOG_PUBLISHER_KEY"],
        message: "CATALOG_PUBLISHER_KEY is required when CATALOG_SOURCE_URL is set (never sync an unsigned catalog)",
      });
    }
    // Fail closed: never check an UNSIGNED update manifest — a manifest URL requires a publisher key.
    if (v.UPDATE_MANIFEST_URL && !v.UPDATE_PUBLISHER_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["UPDATE_PUBLISHER_KEY"],
        message: "UPDATE_PUBLISHER_KEY is required when UPDATE_MANIFEST_URL is set (never check an unsigned manifest)",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  // Treat blank / whitespace-only values as UNSET before validation. An operator who copies
  // .env.example (which ships blank optional keys like ACME_EMAIL="" or UPDATE_MANIFEST_URL="") — or
  // forwards the whole .env into the container via compose `env_file` — would otherwise trip the
  // optional .email()/.url()/base64 validators, which reject "" instead of skipping it. A blank env
  // var universally means "not set" here; a blank REQUIRED key still fails closed (it becomes missing).
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "string" && v.trim() === "") continue;
    cleaned[k] = v;
  }
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

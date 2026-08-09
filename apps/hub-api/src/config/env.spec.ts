import { validateEnv } from "./env";

const base = {
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x",
  JWT_ACCESS_SECRET: "0123456789abcdef",
  JWT_REFRESH_SECRET: "0123456789abcdef",
  SECRETS_ENCRYPTION_KEY: "0123456789abcdef",
};
const signingKey = Buffer.alloc(32, 7).toString("base64"); // valid 32-byte seed

describe("validateEnv — HUB_SIGNING_KEY fail-closed", () => {
  it("rejects production without HUB_SIGNING_KEY (fail-closed)", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "production" })).toThrow(/HUB_SIGNING_KEY/);
  });

  it("rejects an UNSET NODE_ENV without HUB_SIGNING_KEY (fail-closed, treats unset as prod)", () => {
    expect(() => validateEnv({ ...base })).toThrow(/HUB_SIGNING_KEY/);
  });

  it("accepts production with a valid HUB_SIGNING_KEY", () => {
    const env = validateEnv({ ...base, NODE_ENV: "production", HUB_SIGNING_KEY: signingKey });
    expect(env.HUB_SIGNING_KEY).toBe(signingKey);
  });

  it("allows EXPLICIT development/test without HUB_SIGNING_KEY (ephemeral fallback)", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "development" })).not.toThrow();
    expect(() => validateEnv({ ...base, NODE_ENV: "test" })).not.toThrow();
  });

  it("rejects an HUB_SIGNING_KEY that is not a base64 32-byte seed", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "development", HUB_SIGNING_KEY: "too-short" })).toThrow(/HUB_SIGNING_KEY/);
    expect(() => validateEnv({ ...base, NODE_ENV: "development", HUB_SIGNING_KEY: Buffer.alloc(16).toString("base64") })).toThrow(/HUB_SIGNING_KEY/);
  });
});

describe("validateEnv — retention", () => {
  it("defaults raw metric retention to 48h, heartbeat to 30d, and rollup to 30d", () => {
    const env = validateEnv({ ...base, NODE_ENV: "development" });
    expect(env.METRICS_RAW_RETENTION_HOURS).toBe(48);
    expect(env.HEARTBEAT_RETENTION_DAYS).toBe(30);
    expect(env.METRICS_ROLLUP_RETENTION_DAYS).toBe(30);
  });
  it("coerces string overrides to positive integers", () => {
    const env = validateEnv({ ...base, NODE_ENV: "development", METRICS_RAW_RETENTION_HOURS: "72", HEARTBEAT_RETENTION_DAYS: "7", METRICS_ROLLUP_RETENTION_DAYS: "90" });
    expect(env.METRICS_RAW_RETENTION_HOURS).toBe(72);
    expect(env.HEARTBEAT_RETENTION_DAYS).toBe(7);
    expect(env.METRICS_ROLLUP_RETENTION_DAYS).toBe(90);
  });
  it("rejects a non-positive retention", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "development", METRICS_RAW_RETENTION_HOURS: "0" })).toThrow();
    expect(() => validateEnv({ ...base, NODE_ENV: "development", HEARTBEAT_RETENTION_DAYS: "-5" })).toThrow();
    expect(() => validateEnv({ ...base, NODE_ENV: "development", METRICS_ROLLUP_RETENTION_DAYS: "0" })).toThrow();
  });
});

describe("validateEnv — host-port range", () => {
  it("defaults the allocator range to 20000-45000 and coerces overrides", () => {
    const env = validateEnv({ ...base, NODE_ENV: "development" });
    expect(env.TUGRA_HOSTPORT_MIN).toBe(20000);
    expect(env.TUGRA_HOSTPORT_MAX).toBe(45000);
    const over = validateEnv({ ...base, NODE_ENV: "development", TUGRA_HOSTPORT_MIN: "30000", TUGRA_HOSTPORT_MAX: "40000" });
    expect(over.TUGRA_HOSTPORT_MIN).toBe(30000);
    expect(over.TUGRA_HOSTPORT_MAX).toBe(40000);
  });
  it("rejects a range where MIN is not below MAX", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "development", TUGRA_HOSTPORT_MIN: "40000", TUGRA_HOSTPORT_MAX: "30000" })).toThrow();
    expect(() => validateEnv({ ...base, NODE_ENV: "development", TUGRA_HOSTPORT_MIN: "20000", TUGRA_HOSTPORT_MAX: "20000" })).toThrow();
  });
});

describe("validateEnv — remote catalog", () => {
  const pubKey = Buffer.alloc(44, 3).toString("base64"); // 44-byte ed25519 SPKI DER

  it("is unconfigured by default and interval defaults to 60m", () => {
    const env = validateEnv({ ...base, NODE_ENV: "development" });
    expect(env.CATALOG_SOURCE_URL).toBeUndefined();
    expect(env.CATALOG_SYNC_INTERVAL_MIN).toBe(60);
  });

  it("rejects a source URL without a publisher key (fail-closed — never sync unsigned)", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "development", CATALOG_SOURCE_URL: "https://c.example/catalog" })).toThrow(/CATALOG_PUBLISHER_KEY/);
  });

  it("accepts a source URL with a valid publisher key + interval override", () => {
    const env = validateEnv({ ...base, NODE_ENV: "development", CATALOG_SOURCE_URL: "https://c.example/catalog", CATALOG_PUBLISHER_KEY: pubKey, CATALOG_SYNC_INTERVAL_MIN: "30" });
    expect(env.CATALOG_SOURCE_URL).toBe("https://c.example/catalog");
    expect(env.CATALOG_SYNC_INTERVAL_MIN).toBe(30);
  });

  it("rejects a publisher key of the wrong length", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "development", CATALOG_SOURCE_URL: "https://c", CATALOG_PUBLISHER_KEY: Buffer.alloc(32).toString("base64") })).toThrow(/CATALOG_PUBLISHER_KEY/);
  });
});

describe("validateEnv — blank values are treated as UNSET", () => {
  // An operator who copies .env.example (which ships blank optional keys) — or forwards the whole .env
  // into the hub container via compose env_file — must not trip the optional .email()/.url()/base64
  // validators, which would reject "" instead of skipping it.
  it("treats blank/whitespace-only optional keys as unset (no .email()/.url()/base64 failure)", () => {
    const env = validateEnv({
      ...base,
      NODE_ENV: "development",
      ACME_EMAIL: "",
      UPDATE_MANIFEST_URL: "  ",
      UPDATE_PUBLISHER_KEY: "",
      GITHUB_OAUTH_CLIENT_ID: "",
      GITHUB_OAUTH_CLIENT_SECRET: "",
      MAIL_HOST: "",
      CATALOG_SOURCE_URL: "",
      TUGRA_LICENSE: "",
      AGENT_IMAGE: "",
    });
    expect(env.ACME_EMAIL).toBeUndefined();
    expect(env.UPDATE_MANIFEST_URL).toBeUndefined();
    expect(env.GITHUB_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.MAIL_HOST).toBeUndefined();
    expect(env.CATALOG_SOURCE_URL).toBeUndefined();
    expect(env.TUGRA_LICENSE).toBeUndefined();
  });

  it("still honors non-blank optional values", () => {
    const env = validateEnv({ ...base, NODE_ENV: "development", ACME_EMAIL: "ops@example.com" });
    expect(env.ACME_EMAIL).toBe("ops@example.com");
  });

  it("a blank REQUIRED key still fails closed (blank ≠ a valid value)", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "development", DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });
});

describe("validateEnv — MAGIC_DOMAIN_SUFFIX", () => {
  it("defaults to sslip.io when unset", () => {
    expect(validateEnv({ ...base, NODE_ENV: "development" }).MAGIC_DOMAIN_SUFFIX).toBe("sslip.io");
  });
  it("accepts an override (nip.io)", () => {
    expect(
      validateEnv({ ...base, NODE_ENV: "development", MAGIC_DOMAIN_SUFFIX: "nip.io" }).MAGIC_DOMAIN_SUFFIX,
    ).toBe("nip.io");
  });
});

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
  it("defaults raw metric retention to 48h and heartbeat to 30d", () => {
    const env = validateEnv({ ...base, NODE_ENV: "development" });
    expect(env.METRICS_RAW_RETENTION_HOURS).toBe(48);
    expect(env.HEARTBEAT_RETENTION_DAYS).toBe(30);
  });
  it("coerces string overrides to positive integers", () => {
    const env = validateEnv({ ...base, NODE_ENV: "development", METRICS_RAW_RETENTION_HOURS: "72", HEARTBEAT_RETENTION_DAYS: "7" });
    expect(env.METRICS_RAW_RETENTION_HOURS).toBe(72);
    expect(env.HEARTBEAT_RETENTION_DAYS).toBe(7);
  });
  it("rejects a non-positive retention", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "development", METRICS_RAW_RETENTION_HOURS: "0" })).toThrow();
    expect(() => validateEnv({ ...base, NODE_ENV: "development", HEARTBEAT_RETENTION_DAYS: "-5" })).toThrow();
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

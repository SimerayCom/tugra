import { OFFICIAL_UPDATE_MANIFEST_URL, OFFICIAL_UPDATE_PUBLISHER_KEY, applyUpdateCheckDefaults, validateEnv } from "./env";

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

describe("validateEnv — LOCAL_AGENT_ENROLL_TOKEN fail-closed", () => {
  it("rejects a short/guessable turnkey enroll token", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "development", LOCAL_AGENT_ENROLL_TOKEN: "changeme" })).toThrow(/LOCAL_AGENT_ENROLL_TOKEN/);
  });
  it("accepts a high-entropy token (≥32 chars) and leaves it unset otherwise", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "development", LOCAL_AGENT_ENROLL_TOKEN: "a".repeat(48) })).not.toThrow();
    expect(() => validateEnv({ ...base, NODE_ENV: "development" })).not.toThrow(); // optional
  });
});

describe("validateEnv — throttle + redis timeout (ops hardening)", () => {
  it("defaults the global rate limit to 120 req / 60s and the Redis command timeout to 10s", () => {
    const env = validateEnv({ ...base, NODE_ENV: "development" });
    expect(env.THROTTLE_TTL_MS).toBe(60_000);
    expect(env.THROTTLE_LIMIT).toBe(120);
    expect(env.REDIS_COMMAND_TIMEOUT_MS).toBe(10_000);
  });
  it("coerces string overrides to positive integers", () => {
    const env = validateEnv({ ...base, NODE_ENV: "development", THROTTLE_TTL_MS: "30000", THROTTLE_LIMIT: "600", REDIS_COMMAND_TIMEOUT_MS: "5000" });
    expect(env.THROTTLE_TTL_MS).toBe(30_000);
    expect(env.THROTTLE_LIMIT).toBe(600);
    expect(env.REDIS_COMMAND_TIMEOUT_MS).toBe(5_000);
  });
  it("rejects a non-positive throttle/timeout value (fail fast at boot)", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "development", THROTTLE_LIMIT: "0" })).toThrow(/THROTTLE_LIMIT/);
    expect(() => validateEnv({ ...base, NODE_ENV: "development", REDIS_COMMAND_TIMEOUT_MS: "-1" })).toThrow(/REDIS_COMMAND_TIMEOUT_MS/);
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

describe("validateEnv — IMAGE_UPDATE_CHECK_INTERVAL_MIN", () => {
  it("defaults to 360 minutes and accepts 0 (kill switch) and overrides", () => {
    expect(validateEnv({ ...base, NODE_ENV: "development" }).IMAGE_UPDATE_CHECK_INTERVAL_MIN).toBe(360);
    expect(validateEnv({ ...base, NODE_ENV: "development", IMAGE_UPDATE_CHECK_INTERVAL_MIN: "0" }).IMAGE_UPDATE_CHECK_INTERVAL_MIN).toBe(0);
    expect(validateEnv({ ...base, NODE_ENV: "development", IMAGE_UPDATE_CHECK_INTERVAL_MIN: "60" }).IMAGE_UPDATE_CHECK_INTERVAL_MIN).toBe(60);
  });

  it("rejects a negative or fractional interval", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "development", IMAGE_UPDATE_CHECK_INTERVAL_MIN: "-1" })).toThrow();
    expect(() => validateEnv({ ...base, NODE_ENV: "development", IMAGE_UPDATE_CHECK_INTERVAL_MIN: "1.5" })).toThrow();
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
    expect(env.UPDATE_MANIFEST_URL).toBe(OFFICIAL_UPDATE_MANIFEST_URL); // blank pair = unset pair -> the official defaults
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

describe("validateEnv — SECRETS_ENCRYPTION_KEY_PREVIOUS", () => {
  it("accepts a comma-separated list of previous passphrases (each ≥16 chars) and refuses a short one", () => {
    const env = { ...base, NODE_ENV: "development" };
    expect(() => validateEnv({ ...env, SECRETS_ENCRYPTION_KEY_PREVIOUS: "old-passphrase-00001, old-passphrase-00002" })).not.toThrow();
    expect(() => validateEnv({ ...env, SECRETS_ENCRYPTION_KEY_PREVIOUS: "" })).not.toThrow();
    expect(() => validateEnv({ ...env, SECRETS_ENCRYPTION_KEY_PREVIOUS: "short" })).toThrow(/SECRETS_ENCRYPTION_KEY_PREVIOUS/);
  });
});

describe("validateEnv — HUB_TRUSTED_PROXY_CIDRS", () => {
  const env = { ...base, NODE_ENV: "development" };
  it("accepts a valid IP/CIDR list (incl. trust-any) and unset/empty", () => {
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY_CIDRS: "198.51.100.0/24, 2001:db8::/32, 203.0.113.9" })).not.toThrow();
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY_CIDRS: "0.0.0.0/0,::/0" })).not.toThrow();
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY_CIDRS: "" })).not.toThrow();
    expect(() => validateEnv({ ...env })).not.toThrow();
  });
  it("fails boot on an invalid entry", () => {
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY_CIDRS: "198.51.100.0/24, nonsense" })).toThrow(/HUB_TRUSTED_PROXY_CIDRS/);
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY_CIDRS: "10.0.0.0/40" })).toThrow(/HUB_TRUSTED_PROXY_CIDRS/);
  });
});

describe("validateEnv — HUB_TRUSTED_PROXY_STRICT", () => {
  const env = { ...base, NODE_ENV: "development" };
  it("is off by default and when false", () => {
    expect(() => validateEnv({ ...env })).not.toThrow();
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY_STRICT: "false" })).not.toThrow();
  });
  it("accepts true with HUB_TRUSTED_PROXY=true and at least one valid CIDR", () => {
    expect(() =>
      validateEnv({ ...env, HUB_TRUSTED_PROXY: "true", HUB_TRUSTED_PROXY_STRICT: "true", HUB_TRUSTED_PROXY_CIDRS: "172.18.0.0/16" }),
    ).not.toThrow();
  });
  it("fails boot without HUB_TRUSTED_PROXY=true", () => {
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY_STRICT: "true", HUB_TRUSTED_PROXY_CIDRS: "172.18.0.0/16" })).toThrow(
      /HUB_TRUSTED_PROXY_STRICT/,
    );
  });
  it("fails boot with no CIDRs (a strict mode that trusts nobody would collapse every source IP)", () => {
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY: "true", HUB_TRUSTED_PROXY_STRICT: "true" })).toThrow(/HUB_TRUSTED_PROXY_CIDRS/);
    expect(() =>
      validateEnv({ ...env, HUB_TRUSTED_PROXY: "true", HUB_TRUSTED_PROXY_STRICT: "true", HUB_TRUSTED_PROXY_CIDRS: " , " }),
    ).toThrow(/HUB_TRUSTED_PROXY_CIDRS/);
  });
  it("rejects a non-enum value and still rejects an invalid CIDR", () => {
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY_STRICT: "yes" })).toThrow(/HUB_TRUSTED_PROXY_STRICT/);
    expect(() =>
      validateEnv({ ...env, HUB_TRUSTED_PROXY: "true", HUB_TRUSTED_PROXY_STRICT: "true", HUB_TRUSTED_PROXY_CIDRS: "nonsense" }),
    ).toThrow(/HUB_TRUSTED_PROXY_CIDRS/);
  });
});

describe("validateEnv — HUB_TRUSTED_PROXY_CLOUDFLARE", () => {
  const env = { ...base, NODE_ENV: "development" };
  it("is off by default and when false", () => {
    expect(() => validateEnv({ ...env })).not.toThrow();
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY_CLOUDFLARE: "false" })).not.toThrow();
  });
  it("accepts true with HUB_TRUSTED_PROXY=true", () => {
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY: "true", HUB_TRUSTED_PROXY_CLOUDFLARE: "true" })).not.toThrow();
  });
  it("fails boot without HUB_TRUSTED_PROXY=true (fail closed)", () => {
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY_CLOUDFLARE: "true" })).toThrow(/HUB_TRUSTED_PROXY_CLOUDFLARE/);
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY: "false", HUB_TRUSTED_PROXY_CLOUDFLARE: "true" })).toThrow(/HUB_TRUSTED_PROXY_CLOUDFLARE/);
  });
  it("rejects a non-enum value", () => {
    expect(() => validateEnv({ ...env, HUB_TRUSTED_PROXY: "true", HUB_TRUSTED_PROXY_CLOUDFLARE: "yes" })).toThrow(/HUB_TRUSTED_PROXY_CLOUDFLARE/);
  });
  it("validates the extra-ranges list", () => {
    const ok = { ...env, HUB_TRUSTED_PROXY: "true", HUB_TRUSTED_PROXY_CLOUDFLARE: "true" };
    expect(() => validateEnv({ ...ok, HUB_TRUSTED_PROXY_CLOUDFLARE_EXTRA_CIDRS: "198.51.100.0/24,2001:db8::/32" })).not.toThrow();
    expect(() => validateEnv({ ...ok, HUB_TRUSTED_PROXY_CLOUDFLARE_EXTRA_CIDRS: "198.51.100.0/99" })).toThrow(/EXTRA_CIDRS/);
    expect(() => validateEnv({ ...ok, HUB_TRUSTED_PROXY_CLOUDFLARE_EXTRA_CIDRS: "nonsense" })).toThrow(/EXTRA_CIDRS/);
  });
});

describe("validateEnv — MOVE_PART_MIB (clamped, never a boot failure for a number)", () => {
  const run = (v: Record<string, unknown>) => validateEnv({ ...base, NODE_ENV: "development", ...v }).MOVE_PART_MIB;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("defaults to 256 and passes an in-range value through without a warning", () => {
    expect(run({})).toBe(256);
    expect(run({ MOVE_PART_MIB: "" })).toBe(256);
    expect(run({ MOVE_PART_MIB: "64" })).toBe(64);
    expect(warn).not.toHaveBeenCalled();
  });

  it("clamps an out-of-range number to 32..1024 and warns (the documented advice to lower it must not brick the hub)", () => {
    expect(run({ MOVE_PART_MIB: "16" })).toBe(32);
    expect(run({ MOVE_PART_MIB: "2048" })).toBe(1024);
    expect(run({ MOVE_PART_MIB: 5.9 })).toBe(32);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0][0])).toMatch(/MOVE_PART_MIB=16.*32/);
  });

  it("a non-number still fails closed", () => {
    expect(() => run({ MOVE_PART_MIB: "abc" })).toThrow(/MOVE_PART_MIB/);
  });
});

describe("validateEnv — migration volume stream (MIGRATION_VX_*)", () => {
  const dev = { ...base, NODE_ENV: "development" };
  it("defaults keep the documented policy (enabled, 128 MiB parts, 256 GiB, 100000 parts, 5 min, 72 h, 2 seats)", () => {
    const env = validateEnv(dev);
    expect(env).toMatchObject({
      MIGRATION_VX_PART_MIB: 128,
      MIGRATION_VX_MAX_BYTES: 256 * 1024 ** 3,
      MIGRATION_VX_MAX_PARTS: 100_000,
      MIGRATION_VX_STALE_MS: 300_000,
      MIGRATION_TOKEN_MAX_LIFE_HOURS: 72,
      MIGRATION_RELAY_CONCURRENCY: 2,
    });
    expect(env.MIGRATION_VX_ENABLED).toBe("true");
  });
  it("accepts the kill-switch spellings the runtime understands and rejects garbage", () => {
    for (const v of ["false", "FALSE", "0", "off", "no", "true", "1"]) expect(() => validateEnv({ ...dev, MIGRATION_VX_ENABLED: v })).not.toThrow();
    expect(() => validateEnv({ ...dev, MIGRATION_VX_ENABLED: "maybe" })).toThrow();
  });
  it("bounds: part size 32..512, relay seats 1..16, token life >= 1 h", () => {
    for (const bad of [{ MIGRATION_VX_PART_MIB: "8" }, { MIGRATION_VX_PART_MIB: "1024" }, { MIGRATION_RELAY_CONCURRENCY: "0" }, { MIGRATION_RELAY_CONCURRENCY: "17" }, { MIGRATION_TOKEN_MAX_LIFE_HOURS: "0" }, { MIGRATION_VX_MAX_PARTS: "100001" }]) {
      expect(() => validateEnv({ ...dev, ...bad })).toThrow();
    }
    expect(validateEnv({ ...dev, MIGRATION_VX_PART_MIB: "256", MIGRATION_RELAY_CONCURRENCY: "4" })).toMatchObject({ MIGRATION_VX_PART_MIB: 256, MIGRATION_RELAY_CONCURRENCY: 4 });
  });
});

describe("validateEnv — default-on signed update checks", () => {
  const dev = { ...base, NODE_ENV: "development" };

  it("with no UPDATE_* keys applies the official URL + publisher key and an hourly interval", () => {
    const env = validateEnv(dev);
    expect(env.UPDATE_MANIFEST_URL).toBe(OFFICIAL_UPDATE_MANIFEST_URL);
    expect(env.UPDATE_PUBLISHER_KEY).toBe(OFFICIAL_UPDATE_PUBLISHER_KEY);
    expect(env.UPDATE_CHECK_INTERVAL_MIN).toBe(60);
  });

  it("TUGRA_UPDATE_CHECKS=0 is a hard off: no defaults are injected", () => {
    const env = validateEnv({ ...dev, TUGRA_UPDATE_CHECKS: "0" });
    expect(env.UPDATE_MANIFEST_URL).toBeUndefined();
    expect(env.UPDATE_PUBLISHER_KEY).toBeUndefined();
  });

  it("TUGRA_UPDATE_CHECKS=1 keeps the defaults; anything else is rejected", () => {
    expect(validateEnv({ ...dev, TUGRA_UPDATE_CHECKS: "1" }).UPDATE_MANIFEST_URL).toBe(OFFICIAL_UPDATE_MANIFEST_URL);
    expect(() => validateEnv({ ...dev, TUGRA_UPDATE_CHECKS: "yes" })).toThrow(/TUGRA_UPDATE_CHECKS/);
  });

  it("a custom URL + key pair is left untouched", () => {
    const env = validateEnv({ ...dev, UPDATE_MANIFEST_URL: "https://mirror.example/versions.json", UPDATE_PUBLISHER_KEY: OFFICIAL_UPDATE_PUBLISHER_KEY });
    expect(env.UPDATE_MANIFEST_URL).toBe("https://mirror.example/versions.json");
    expect(env.UPDATE_PUBLISHER_KEY).toBe(OFFICIAL_UPDATE_PUBLISHER_KEY);
  });

  it("a URL without a key still fails closed, and the message names the opt-out", () => {
    expect(() => validateEnv({ ...dev, UPDATE_MANIFEST_URL: "https://mirror.example/versions.json" })).toThrow(/TUGRA_UPDATE_CHECKS=0/);
  });

  it("the opt-out the message names really works: TUGRA_UPDATE_CHECKS=0 boots a half pair and drops it", () => {
    const env = validateEnv({ ...dev, TUGRA_UPDATE_CHECKS: "0", UPDATE_MANIFEST_URL: "https://mirror.example/versions.json" });
    expect(env.UPDATE_MANIFEST_URL).toBeUndefined();
    expect(env.UPDATE_PUBLISHER_KEY).toBeUndefined();
    expect(env.TUGRA_UPDATE_CHECKS).toBe("0");
  });

  it("a key without a URL injects nothing (the operator touched the pair)", () => {
    const env = validateEnv({ ...dev, UPDATE_PUBLISHER_KEY: OFFICIAL_UPDATE_PUBLISHER_KEY });
    expect(env.UPDATE_MANIFEST_URL).toBeUndefined();
    expect(env.UPDATE_PUBLISHER_KEY).toBe(OFFICIAL_UPDATE_PUBLISHER_KEY);
  });

  it("blank strings for both keys (the shipped .env.example) still get the defaults", () => {
    const env = validateEnv({ ...dev, UPDATE_MANIFEST_URL: "", UPDATE_PUBLISHER_KEY: " " });
    expect(env.UPDATE_MANIFEST_URL).toBe(OFFICIAL_UPDATE_MANIFEST_URL);
    expect(env.UPDATE_PUBLISHER_KEY).toBe(OFFICIAL_UPDATE_PUBLISHER_KEY);
  });

  it("applyUpdateCheckDefaults is pure (does not mutate its input)", () => {
    const input = { A: "1" };
    const out = applyUpdateCheckDefaults(input);
    expect(input).toEqual({ A: "1" });
    expect(out.UPDATE_MANIFEST_URL).toBe(OFFICIAL_UPDATE_MANIFEST_URL);
  });
});

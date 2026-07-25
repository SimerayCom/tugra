import { ConfigService } from "@nestjs/config";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import { LicenseService } from "./license.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { currentEdition, setLicensedEdition } from "../common/edition";

// A real ed25519 keypair (the "Tugra license key") + an unrelated one (to test wrong-key rejection).
const kp = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const PUB_B64 = kp.publicKey.export({ type: "spki", format: "der" }).toString("base64");

const ORIGINAL_EDITION = process.env.TUGRA_EDITION;
afterEach(() => {
  setLicensedEdition(null); // module state — reset so tests don't leak the licensed edition
  if (ORIGINAL_EDITION === undefined) delete process.env.TUGRA_EDITION;
  else process.env.TUGRA_EDITION = ORIGINAL_EDITION;
});

async function sign(
  priv: KeyObject,
  claims: Record<string, unknown>,
  opts: { alg?: string; exp?: string | number | null } = {},
): Promise<string> {
  const jwt = new SignJWT(claims).setProtectedHeader({ alg: opts.alg ?? "EdDSA" }).setIssuedAt();
  if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? "30d");
  return jwt.sign(priv);
}

function makeConfig(vals: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => vals[k] } as unknown as ConfigService;
}
function makeSettings(licenseToken?: string | null): InstanceSettingsService {
  return { get: jest.fn().mockResolvedValue({ licenseToken: licenseToken ?? null }) } as unknown as InstanceSettingsService;
}
function make(vals: Record<string, string | undefined> = { TUGRA_LICENSE_PUBLISHER_KEY: PUB_B64 }, licenseToken?: string | null) {
  return new LicenseService(makeConfig(vals), makeSettings(licenseToken));
}

describe("LicenseService.verifyToken", () => {
  it("accepts a valid EdDSA pro license and returns the edition + expiry", async () => {
    const token = await sign(kp.privateKey, { edition: "pro" });
    const { edition, expiresAt } = await make().verifyToken(token);
    expect(edition).toBe("pro");
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("accepts a cloud license", async () => {
    const token = await sign(kp.privateKey, { edition: "cloud" });
    expect((await make().verifyToken(token)).edition).toBe("cloud");
  });

  it("rejects an expired license", async () => {
    const token = await sign(kp.privateKey, { edition: "pro" }, { exp: Math.floor(Date.now() / 1000) - 3600 });
    await expect(make().verifyToken(token)).rejects.toThrow();
  });

  it("rejects a license signed by a different key", async () => {
    const token = await sign(other.privateKey, { edition: "pro" });
    await expect(make().verifyToken(token)).rejects.toThrow();
  });

  it("rejects a tampered token", async () => {
    const token = await sign(kp.privateKey, { edition: "pro" });
    const parts = token.split(".");
    parts[1] = Buffer.from(JSON.stringify({ edition: "cloud", exp: 9999999999 })).toString("base64url");
    await expect(make().verifyToken(parts.join("."))).rejects.toThrow();
  });

  it("rejects a non-EdDSA (HS256) token — algorithm is pinned", async () => {
    const hs = await new SignJWT({ edition: "pro" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode("a-shared-secret-value-32-bytes!!"));
    await expect(make().verifyToken(hs)).rejects.toThrow();
  });

  it("rejects a license with no expiry (no perpetual entitlement by omission)", async () => {
    const token = await sign(kp.privateKey, { edition: "pro" }, { exp: null });
    await expect(make().verifyToken(token)).rejects.toThrow(/expiry/);
  });

  it("rejects a license that does not grant a paid edition", async () => {
    const token = await sign(kp.privateKey, { edition: "community" });
    await expect(make().verifyToken(token)).rejects.toThrow(/paid edition/);
  });

  it("throws when licensing is not configured (no publisher key)", async () => {
    const token = await sign(kp.privateKey, { edition: "pro" });
    await expect(make({}).verifyToken(token)).rejects.toThrow(/not configured/);
  });

  it("IGNORES the env key override in production — an operator cannot supply their own trust anchor", async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      // Operator self-signs and sets their own key in the env; production uses only the (empty) compiled
      // key, so verification is refused — no self-grant.
      const token = await sign(kp.privateKey, { edition: "cloud" });
      await expect(make({ TUGRA_LICENSE_PUBLISHER_KEY: PUB_B64 }).verifyToken(token)).rejects.toThrow(/not configured/);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe("LicenseService.refresh + currentEdition", () => {
  it("a valid DB license raises the effective edition and reports valid+db", async () => {
    delete process.env.TUGRA_EDITION; // → community env
    const token = await sign(kp.privateKey, { edition: "pro" });
    const svc = make({ TUGRA_LICENSE_PUBLISHER_KEY: PUB_B64 }, token);
    await svc.refresh();
    expect(currentEdition()).toBe("pro");
    const st = svc.status();
    expect(st).toMatchObject({ plan: "pro", valid: true, source: "db" });
    expect(st.expiresAt).toMatch(/^\d{4}-/);
  });

  it("falls back to the TUGRA_LICENSE env token when no DB token is present", async () => {
    delete process.env.TUGRA_EDITION;
    const token = await sign(kp.privateKey, { edition: "cloud" });
    const svc = make({ TUGRA_LICENSE_PUBLISHER_KEY: PUB_B64, TUGRA_LICENSE: token }, null);
    await svc.refresh();
    expect(currentEdition()).toBe("cloud");
    expect(svc.status()).toMatchObject({ plan: "cloud", valid: true, source: "env" });
  });

  it("an invalid DB token grants nothing (stays community) but reports the source for the owner", async () => {
    delete process.env.TUGRA_EDITION;
    const bad = await sign(other.privateKey, { edition: "pro" });
    const svc = make({ TUGRA_LICENSE_PUBLISHER_KEY: PUB_B64 }, bad);
    await svc.refresh();
    expect(currentEdition()).toBe("community");
    expect(svc.status()).toMatchObject({ plan: "community", valid: false, source: "db" });
  });

  it("falls through to a valid env token when the DB token is invalid (no silent downgrade)", async () => {
    delete process.env.TUGRA_EDITION;
    const badDb = await sign(other.privateKey, { edition: "pro" }); // wrong key → won't verify
    const goodEnv = await sign(kp.privateKey, { edition: "cloud" });
    const svc = make({ TUGRA_LICENSE_PUBLISHER_KEY: PUB_B64, TUGRA_LICENSE: goodEnv }, badDb);
    await svc.refresh();
    expect(currentEdition()).toBe("cloud");
    expect(svc.status()).toMatchObject({ plan: "cloud", valid: true, source: "env" });
  });

  it("no token → no license, no source", async () => {
    delete process.env.TUGRA_EDITION;
    const svc = make({ TUGRA_LICENSE_PUBLISHER_KEY: PUB_B64 }, null);
    await svc.refresh();
    expect(svc.status()).toMatchObject({ plan: "community", valid: false, source: null });
  });

  it("a license only RAISES the edition — a cloud env build with no license stays cloud", async () => {
    process.env.TUGRA_EDITION = "cloud";
    const svc = make({ TUGRA_LICENSE_PUBLISHER_KEY: PUB_B64 }, null);
    await svc.refresh();
    expect(currentEdition()).toBe("cloud");
  });

  it("onModuleInit verifies the license at boot", async () => {
    delete process.env.TUGRA_EDITION;
    const token = await sign(kp.privateKey, { edition: "pro" });
    const svc = make({ TUGRA_LICENSE_PUBLISHER_KEY: PUB_B64 }, token);
    await svc.onModuleInit();
    expect(currentEdition()).toBe("pro");
  });
});

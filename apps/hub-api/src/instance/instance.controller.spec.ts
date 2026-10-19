import type { ConfigService } from "@nestjs/config";
import { InstanceController } from "./instance.controller";
import type { InstanceSettingsService } from "./instance-settings.service";

function controllerWith(settings: Record<string, unknown>, setupCode?: string): InstanceController {
  const config = { get: (k: string) => (k === "SETUP_CODE" ? setupCode : undefined) } as unknown as ConfigService;
  return new InstanceController({ get: jest.fn().mockResolvedValue(settings) } as unknown as InstanceSettingsService, config);
}

// `edition` is env-authoritative (currentEdition() reads TUGRA_EDITION), NOT the DB column.
const ORIGINAL = process.env.TUGRA_EDITION;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TUGRA_EDITION;
  else process.env.TUGRA_EDITION = ORIGINAL;
});

describe("InstanceController", () => {
  it("reports initialized=false and the env edition before the first user is claimed", async () => {
    delete process.env.TUGRA_EDITION; // → community
    const res = await controllerWith({ initializedAt: null, allowRegistration: false }).status();
    expect(res).toEqual({ initialized: false, allowRegistration: false, edition: "community", ssoEnabled: false, setupCodeRequired: false });
  });

  it("reports initialized=true and the env edition (ignoring the inert DB column)", async () => {
    process.env.TUGRA_EDITION = "pro";
    // Even if the DB row said community, the env is authoritative:
    const res = await controllerWith({ initializedAt: new Date(), allowRegistration: true, edition: "community" }).status();
    expect(res).toEqual({ initialized: true, allowRegistration: true, edition: "pro", ssoEnabled: false, setupCodeRequired: false });
  });

  it("does not leak any other settings fields (only the public set)", async () => {
    const res = await controllerWith({
      initializedAt: new Date(),
      allowRegistration: false,
      acmeEmail: "secret@x.io",
      apiAllowedIps: ["10.0.0.1"],
      publicUrl: "https://internal",
      oidcClientSecretEnc: "ENC(shh)",
    }).status();
    expect(Object.keys(res).sort()).toEqual(["allowRegistration", "edition", "initialized", "setupCodeRequired", "ssoEnabled"]);
  });

  it("setupCodeRequired is true only when a SETUP_CODE is configured AND the instance is not yet initialized", async () => {
    // code set + fresh → required (the welcome form must ask for it)
    expect((await controllerWith({ initializedAt: null, allowRegistration: false }, "abcd1234").status()).setupCodeRequired).toBe(true);
    // code set but already initialized → no longer required
    expect((await controllerWith({ initializedAt: new Date(), allowRegistration: false }, "abcd1234").status()).setupCodeRequired).toBe(false);
    // no code configured → never required
    expect((await controllerWith({ initializedAt: null, allowRegistration: false }).status()).setupCodeRequired).toBe(false);
  });

  it("never exposes the setup code itself — only the boolean", async () => {
    const res = await controllerWith({ initializedAt: null, allowRegistration: false }, "supersecretcode").status();
    expect(JSON.stringify(res)).not.toContain("supersecretcode");
  });

  it("ssoEnabled is true only on a Pro+ edition with OIDC enabled + fully configured", async () => {
    process.env.TUGRA_EDITION = "pro";
    const configured = { initializedAt: new Date(), allowRegistration: false, oidcEnabled: true, oidcIssuer: "https://idp", oidcClientId: "cid", oidcClientSecretEnc: "ENC(x)" };
    expect((await controllerWith(configured).status()).ssoEnabled).toBe(true);
    // Missing secret → not enabled.
    expect((await controllerWith({ ...configured, oidcClientSecretEnc: null }).status()).ssoEnabled).toBe(false);
  });

  it("ssoEnabled is false on Community even when OIDC is fully configured (downgrade soft-disables)", async () => {
    delete process.env.TUGRA_EDITION; // → community
    const res = await controllerWith({ initializedAt: new Date(), allowRegistration: false, oidcEnabled: true, oidcIssuer: "https://idp", oidcClientId: "cid", oidcClientSecretEnc: "ENC(x)" }).status();
    expect(res.ssoEnabled).toBe(false);
  });
});

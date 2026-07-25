import { InstanceSettingsController } from "./instance-settings.controller";
import type { InstanceSettingsService } from "./instance-settings.service";
import type { AuditService } from "../audit/audit.service";
import type { AuthUser } from "../auth/strategies/jwt.strategy";
import type { UpdateService } from "../update/update.service";
import type { UpdaterService } from "../update/updater.service";
import type { CryptoService } from "../crypto/crypto.service";
import { REQUIRE_EDITION } from "../common/edition";

// The SSRF guard does real DNS resolution (tested in safe-url's own spec); mock it here so the controller
// tests are deterministic and offline. Default: resolves (safe). A test overrides it to reject for the
// private-issuer case.
jest.mock("../notifications/safe-url", () => ({
  assertSafeUrl: jest.fn().mockResolvedValue(undefined),
  allowPrivateTargets: jest.fn(() => false),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { assertSafeUrl } from "../notifications/safe-url";
const mockAssertSafeUrl = assertSafeUrl as jest.Mock;
beforeEach(() => mockAssertSafeUrl.mockReset().mockResolvedValue(undefined));

const OWNER = { userId: "owner1", scopes: ["*"] } as AuthUser;

interface CurrentSettings {
  apiEnabled: boolean;
  apiAllowedIps: string[];
  publicUrl?: string | null;
  acmeEmail?: string | null;
  oidcEnabled?: boolean;
  oidcIssuer?: string | null;
  oidcClientId?: string | null;
  oidcClientSecretEnc?: string | null;
  oidcAllowedDomains?: string[];
}

function make(current: CurrentSettings) {
  const full = {
    publicUrl: null,
    acmeEmail: null,
    oidcEnabled: false,
    oidcIssuer: null,
    oidcClientId: null,
    oidcClientSecretEnc: null,
    oidcAllowedDomains: [] as string[],
    ...current,
  };
  const updated = { ...full };
  const settings = {
    get: jest.fn().mockResolvedValue(full),
    update: jest.fn().mockImplementation((patch) => Promise.resolve(Object.assign(updated, patch))),
  } as unknown as InstanceSettingsService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const crypto = { encrypt: jest.fn((s: string) => `ENC(${s})`) } as unknown as CryptoService;
  const update = {
    getStatus: jest.fn().mockResolvedValue({
      current: "0.0.0-dev",
      latest: null,
      channel: "stable",
      updateAvailable: false,
      changelogUrl: null,
      autoUpdate: false,
    }),
    checkRemote: jest.fn().mockResolvedValue({ status: "unconfigured" }),
  } as unknown as UpdateService;
  const updater = {
    requestUpdate: jest.fn().mockResolvedValue({ status: "started", targetVersion: "0.2.0" }),
    getProgress: jest.fn().mockResolvedValue({ phase: "idle", targetVersion: null, error: null }),
  } as unknown as UpdaterService;
  return { ctrl: new InstanceSettingsController(settings, audit, update, updater, crypto), settings, audit, update, updater, crypto };
}

const ORIGINAL_EDITION = process.env.TUGRA_EDITION;
afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.TUGRA_EDITION;
  else process.env.TUGRA_EDITION = ORIGINAL_EDITION;
});

describe("InstanceSettingsController", () => {
  it("returns the API-gating fields, onboarding basics, plus the read-only env edition", async () => {
    process.env.TUGRA_EDITION = "pro";
    const { ctrl } = make({ apiEnabled: true, apiAllowedIps: ["10.0.0.0/8"], publicUrl: "https://hub.example.com", acmeEmail: "a@b.co" });
    expect(await ctrl.getSettings()).toEqual({
      apiEnabled: true,
      apiAllowedIps: ["10.0.0.0/8"],
      publicUrl: "https://hub.example.com",
      acmeEmail: "a@b.co",
      edition: "pro",
    });
  });

  it("patches apiEnabled + apiAllowedIps (dropping blanks) and audits", async () => {
    const { ctrl, settings, audit } = make({ apiEnabled: true, apiAllowedIps: [] });
    const res = await ctrl.updateSettings(OWNER, { apiEnabled: false, apiAllowedIps: ["1.2.3.4", "", "  ", "10.0.0.0/8"] });
    expect(settings.update).toHaveBeenCalledWith({ apiEnabled: false, apiAllowedIps: ["1.2.3.4", "10.0.0.0/8"] });
    expect(res).toEqual({ apiEnabled: false, apiAllowedIps: ["1.2.3.4", "10.0.0.0/8"], publicUrl: null, acmeEmail: null });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "instance_settings.update", actor: "owner1" }));
  });

  it("only patches the fields present in the body", async () => {
    const { ctrl, settings } = make({ apiEnabled: true, apiAllowedIps: [] });
    await ctrl.updateSettings(OWNER, { apiEnabled: false });
    expect(settings.update).toHaveBeenCalledWith({ apiEnabled: false });
  });

  it("sets publicUrl + acmeEmail (onboarding basics)", async () => {
    const { ctrl, settings } = make({ apiEnabled: true, apiAllowedIps: [] });
    const res = await ctrl.updateSettings(OWNER, { publicUrl: "https://hub.example.com", acmeEmail: "ops@example.com" });
    expect(settings.update).toHaveBeenCalledWith({ publicUrl: "https://hub.example.com", acmeEmail: "ops@example.com" });
    expect(res).toMatchObject({ publicUrl: "https://hub.example.com", acmeEmail: "ops@example.com" });
  });

  it("clears publicUrl + acmeEmail when the owner submits empty strings (falsy → null)", async () => {
    const { ctrl, settings } = make({ apiEnabled: true, apiAllowedIps: [], publicUrl: "https://old", acmeEmail: "old@x.co" });
    await ctrl.updateSettings(OWNER, { publicUrl: "", acmeEmail: "" });
    expect(settings.update).toHaveBeenCalledWith({ publicUrl: null, acmeEmail: null });
  });

  it("getUpdate delegates to UpdateService.getStatus", async () => {
    const { ctrl, update } = make({ apiEnabled: true, apiAllowedIps: [] });
    const out = await ctrl.getUpdate();
    expect(update.getStatus).toHaveBeenCalled();
    expect(out).toMatchObject({ current: "0.0.0-dev", updateAvailable: false, latest: null });
  });

  it("setUpdate persists channel + autoUpdate, audits, and returns the status (no remote fetch)", async () => {
    const { ctrl, settings, audit, update } = make({ apiEnabled: true, apiAllowedIps: [] });
    const out = await ctrl.setUpdate(OWNER, { autoUpdate: true, updateChannel: "beta" });
    expect(settings.update).toHaveBeenCalledWith({ autoUpdate: true, updateChannel: "beta" });
    expect(update.checkRemote).not.toHaveBeenCalled(); // PATCH is fast — never fetches
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "instance_update.settings", actor: "owner1" }));
    expect(out).toMatchObject({ channel: "stable" }); // getStatus() shape
  });

  it("setUpdate only patches the fields present in the body", async () => {
    const { ctrl, settings } = make({ apiEnabled: true, apiAllowedIps: [] });
    await ctrl.setUpdate(OWNER, { autoUpdate: false });
    expect(settings.update).toHaveBeenCalledWith({ autoUpdate: false });
  });

  it("checkUpdate triggers a remote re-check then returns the fresh status", async () => {
    const { ctrl, update } = make({ apiEnabled: true, apiAllowedIps: [] });
    const out = await ctrl.checkUpdate();
    expect(update.checkRemote).toHaveBeenCalled();
    expect(update.getStatus).toHaveBeenCalled();
    expect(out).toMatchObject({ current: "0.0.0-dev" });
  });

  it("applyUpdate delegates to the updater, audits on start, and returns the result", async () => {
    const { ctrl, updater, audit } = make({ apiEnabled: true, apiAllowedIps: [] });
    const out = await ctrl.applyUpdate(OWNER);
    expect(updater.requestUpdate).toHaveBeenCalledWith({ actor: "owner1", auto: false });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "instance_update.apply", actor: "owner1" }));
    expect(out).toEqual({ status: "started", targetVersion: "0.2.0" });
  });

  it("applyUpdate maps an already-running update to a 409 (and does not audit)", async () => {
    const { ctrl, updater, audit } = make({ apiEnabled: true, apiAllowedIps: [] });
    (updater.requestUpdate as jest.Mock).mockResolvedValue({ status: "in-progress", targetVersion: "0.2.0" });
    await expect(ctrl.applyUpdate(OWNER)).rejects.toThrow(/already in progress/);
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "instance_update.apply" }));
  });

  it("applyUpdate does not audit a no-op (up-to-date)", async () => {
    const { ctrl, updater, audit } = make({ apiEnabled: true, apiAllowedIps: [] });
    (updater.requestUpdate as jest.Mock).mockResolvedValue({ status: "up-to-date", targetVersion: "0.1.0" });
    const out = await ctrl.applyUpdate(OWNER);
    expect(out).toEqual({ status: "up-to-date", targetVersion: "0.1.0" });
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "instance_update.apply" }));
  });

  it("streamUpdate returns an Observable of update progress", () => {
    const { ctrl } = make({ apiEnabled: true, apiAllowedIps: [] });
    expect(typeof ctrl.streamUpdate().subscribe).toBe("function");
  });
});

describe("InstanceSettingsController — OIDC config", () => {
  it("getOidc returns the config with clientSecretSet, never the secret itself", async () => {
    const { ctrl } = make({
      apiEnabled: true,
      apiAllowedIps: [],
      oidcEnabled: true,
      oidcIssuer: "https://idp.example.com",
      oidcClientId: "cid",
      oidcClientSecretEnc: "ENC(shh)",
      oidcAllowedDomains: ["corp.io"],
    });
    const res = await ctrl.getOidc();
    expect(res).toEqual({
      oidcEnabled: true,
      oidcIssuer: "https://idp.example.com",
      oidcClientId: "cid",
      oidcAllowedDomains: ["corp.io"],
      clientSecretSet: true,
    });
    expect(Object.keys(res)).not.toContain("oidcClientSecretEnc"); // secret never surfaced
  });

  it("updateOidc encrypts the client secret, normalizes domains, persists and audits (secret not logged)", async () => {
    const { ctrl, settings, audit, crypto } = make({ apiEnabled: true, apiAllowedIps: [] });
    const res = await ctrl.updateOidc(OWNER, {
      oidcEnabled: true,
      oidcIssuer: "https://idp.example.com",
      oidcClientId: "cid",
      oidcClientSecret: "topsecret",
      oidcAllowedDomains: ["Corp.IO", "  ", "sub.corp.io"],
    });
    expect(crypto.encrypt).toHaveBeenCalledWith("topsecret");
    expect(settings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        oidcEnabled: true,
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "cid",
        oidcClientSecretEnc: "ENC(topsecret)",
        oidcAllowedDomains: ["corp.io", "sub.corp.io"],
      }),
    );
    expect(res.clientSecretSet).toBe(true);
    // The audit entry (and the returned view) must not carry the plaintext or the ciphertext.
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(auditArg)).not.toContain("topsecret");
    expect(JSON.stringify(res)).not.toContain("topsecret");
    expect(res).not.toHaveProperty("oidcClientSecretEnc");
  });

  it("does NOT re-encrypt when the secret is omitted (preserves the stored one)", async () => {
    const { ctrl, settings, crypto } = make({
      apiEnabled: true,
      apiAllowedIps: [],
      oidcEnabled: true,
      oidcIssuer: "https://idp.example.com",
      oidcClientId: "cid",
      oidcClientSecretEnc: "ENC(existing)",
    });
    await ctrl.updateOidc(OWNER, { oidcAllowedDomains: ["corp.io"] });
    expect(crypto.encrypt).not.toHaveBeenCalled();
    expect(settings.update).toHaveBeenCalledWith(expect.not.objectContaining({ oidcClientSecretEnc: expect.anything() }));
  });

  it("rejects enabling SSO without a full issuer + clientId + secret", async () => {
    const { ctrl, settings } = make({ apiEnabled: true, apiAllowedIps: [] });
    await expect(ctrl.updateOidc(OWNER, { oidcEnabled: true, oidcIssuer: "https://idp.example.com", oidcClientId: "cid" })).rejects.toThrow(/required to enable/);
    expect(settings.update).not.toHaveBeenCalled();
  });

  it("rejects a private/loopback issuer URL (SSRF guard)", async () => {
    const { ctrl, settings } = make({ apiEnabled: true, apiAllowedIps: [] });
    mockAssertSafeUrl.mockRejectedValueOnce(new Error("blocked address"));
    await expect(ctrl.updateOidc(OWNER, { oidcIssuer: "http://10.0.0.1" })).rejects.toThrow(/not allowed/);
    expect(settings.update).not.toHaveBeenCalled();
  });

  it("clears issuer/clientId when the owner submits empty strings (falsy → null)", async () => {
    const { ctrl, settings } = make({
      apiEnabled: true,
      apiAllowedIps: [],
      oidcIssuer: "https://old.example.com",
      oidcClientId: "old",
    });
    await ctrl.updateOidc(OWNER, { oidcIssuer: "", oidcClientId: "" });
    expect(settings.update).toHaveBeenCalledWith(expect.objectContaining({ oidcIssuer: null, oidcClientId: null }));
  });

  it("marks getOidc + updateOidc as Pro-gated via @RequireEdition metadata", () => {
    expect(Reflect.getMetadata(REQUIRE_EDITION, InstanceSettingsController.prototype.getOidc)).toBe("pro");
    expect(Reflect.getMetadata(REQUIRE_EDITION, InstanceSettingsController.prototype.updateOidc)).toBe("pro");
  });
});

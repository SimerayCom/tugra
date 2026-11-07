import { InstanceSettingsService } from "./instance-settings.service";
import { PrismaService } from "../prisma/prisma.service";
import type { CryptoService } from "../crypto/crypto.service";

const ROW = {
  id: "singleton",
  initializedAt: null,
  allowRegistration: false,
  edition: "community",
  apiEnabled: true,
  apiAllowedIps: [] as string[],
};

function make(over: { findUnique?: jest.Mock; upsert?: jest.Mock; update?: jest.Mock } = {}) {
  const findUnique = over.findUnique ?? jest.fn().mockResolvedValue(ROW);
  const upsert = over.upsert ?? jest.fn().mockResolvedValue(ROW);
  const update = over.update ?? jest.fn().mockResolvedValue(ROW);
  const prisma = { instanceSettings: { findUnique, upsert, update } } as unknown as PrismaService;
  const crypto = { encrypt: jest.fn((s: string) => `ENC(${s})`) };
  return { svc: new InstanceSettingsService(prisma, crypto as unknown as CryptoService), findUnique, upsert, update, crypto };
}

describe("InstanceSettingsService", () => {
  it("get() returns the existing singleton WITHOUT writing (read-only in steady state)", async () => {
    const { svc, findUnique, upsert } = make();
    const out = await svc.get();
    expect(out).toBe(ROW);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "singleton" } });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("get() creates the singleton on first access (row missing), race-safe with an empty update", async () => {
    const { svc, upsert } = make({ findUnique: jest.fn().mockResolvedValue(null) });
    const out = await svc.get();
    expect(out).toBe(ROW);
    expect(upsert).toHaveBeenCalledWith({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
  });

  it("get() is idempotent — repeated reads never write once the row exists", async () => {
    const { svc, findUnique, upsert } = make();
    await svc.get();
    await svc.get();
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("update() ensures the row exists then patches the singleton", async () => {
    const { svc, update } = make({ update: jest.fn().mockResolvedValue({ ...ROW, allowRegistration: true }) });
    const out = await svc.update({ allowRegistration: true });
    expect(update).toHaveBeenCalledWith({ where: { id: "singleton" }, data: { allowRegistration: true } });
    expect(out.allowRegistration).toBe(true);
  });
});

describe("InstanceSettingsService.acmeEmailFor", () => {
  it("prefers the env value (ACME_EMAIL wins)", async () => {
    const { svc } = make({ findUnique: jest.fn().mockResolvedValue({ ...ROW, acmeEmail: "db@x.io" }) });
    expect(await svc.acmeEmailFor("env@x.io")).toBe("env@x.io");
  });
  it("falls back to the stored onboarding acmeEmail when env is unset/blank (the fix: the field now drives certs)", async () => {
    const { svc } = make({ findUnique: jest.fn().mockResolvedValue({ ...ROW, acmeEmail: "db@x.io" }) });
    expect(await svc.acmeEmailFor(undefined)).toBe("db@x.io");
    expect(await svc.acmeEmailFor("   ")).toBe("db@x.io");
  });
  it("undefined when neither env nor stored email is set (proxy script uses its placeholder)", async () => {
    const { svc } = make({ findUnique: jest.fn().mockResolvedValue({ ...ROW, acmeEmail: null }) });
    expect(await svc.acmeEmailFor(undefined)).toBeUndefined();
  });
});

describe("InstanceSettingsService.effectiveBranding (Pro paywall at read time)", () => {
  const ORIGINAL = process.env.TUGRA_EDITION;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TUGRA_EDITION;
    else process.env.TUGRA_EDITION = ORIGINAL;
  });

  const branded = {
    ...ROW,
    brandName: "Acme",
    brandLogoUrl: "https://acme.test/logo.svg",
    brandFaviconUrl: "https://acme.test/favicon.png",
    brandAccentColor: "#112233",
    brandHidePoweredBy: true,
  };

  it("returns the Tugra defaults on Community even when brand fields ARE set", async () => {
    delete process.env.TUGRA_EDITION; // normalises to community
    const { svc } = make({ findUnique: jest.fn().mockResolvedValue(branded) });
    expect(await svc.effectiveBranding()).toEqual({ name: null, logoUrl: null, faviconUrl: null, accentColor: null, hidePoweredBy: false });
  });

  it("returns the stored branding on Pro", async () => {
    process.env.TUGRA_EDITION = "pro";
    const { svc } = make({ findUnique: jest.fn().mockResolvedValue(branded) });
    expect(await svc.effectiveBranding()).toEqual({
      name: "Acme",
      logoUrl: "https://acme.test/logo.svg",
      faviconUrl: "https://acme.test/favicon.png",
      accentColor: "#112233",
      hidePoweredBy: true,
    });
  });
});

describe("InstanceSettingsService — mail settings", () => {
  const MAILROW = { ...ROW, mailProvider: "smtp", mailHost: "h.example.com", mailPort: 587, mailSecure: false, mailUser: "u", mailPassEnc: "ENC(old)", mailFrom: "a@b.co", mailResendKeyEnc: null };

  it("getMailSettings returns the config + hasPassword/hasResendKey booleans and NEVER a secret value", async () => {
    const { svc } = make({ findUnique: jest.fn().mockResolvedValue({ ...MAILROW, mailResendKeyEnc: "ENC(re_k)" }) });
    const v = await svc.getMailSettings();
    expect(v).toEqual({ provider: "smtp", host: "h.example.com", port: 587, secure: false, user: "u", from: "a@b.co", hasPassword: true, hasResendKey: true });
    const json = JSON.stringify(v);
    expect(json).not.toContain("ENC(");
    expect(json).not.toContain("old");
    expect(json).not.toContain("re_k");
  });

  it("defaults to provider none with no secrets set", async () => {
    const { svc } = make();
    expect(await svc.getMailSettings()).toMatchObject({ provider: "none", hasPassword: false, hasResendKey: false });
  });

  it("setMailSettings encrypts the password and resend key before storing (plaintext never reaches the DB)", async () => {
    const { svc, update, crypto } = make({ findUnique: jest.fn().mockResolvedValue({ ...ROW, mailProvider: "none" }), update: jest.fn().mockResolvedValue({ ...MAILROW }) });
    await svc.setMailSettings({ provider: "smtp", host: "h.example.com", from: "a@b.co", password: "pw-plain", resendKey: "re_plain" });
    expect(crypto.encrypt).toHaveBeenCalledWith("pw-plain");
    expect(crypto.encrypt).toHaveBeenCalledWith("re_plain");
    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({ mailProvider: "smtp", mailHost: "h.example.com", mailPassEnc: "ENC(pw-plain)", mailResendKeyEnc: "ENC(re_plain)" });
    expect(JSON.stringify(data)).not.toMatch(/"pw-plain"|"re_plain"/);
  });

  it("a blank / omitted secret leaves the stored ciphertext untouched (write-only replace semantics)", async () => {
    const { svc, update, crypto } = make({ findUnique: jest.fn().mockResolvedValue(MAILROW), update: jest.fn().mockResolvedValue(MAILROW) });
    await svc.setMailSettings({ host: "new.example.com", password: "", resendKey: "" });
    await svc.setMailSettings({ from: "x@y.co" });
    expect(crypto.encrypt).not.toHaveBeenCalled();
    for (const call of update.mock.calls) {
      expect(call[0].data).not.toHaveProperty("mailPassEnc");
      expect(call[0].data).not.toHaveProperty("mailResendKeyEnc");
    }
  });

  it("maps blank text fields to null (clearable) and only patches provided fields", async () => {
    const { svc, update } = make({ findUnique: jest.fn().mockResolvedValue({ ...MAILROW, mailProvider: "none" }), update: jest.fn().mockResolvedValue(MAILROW) });
    await svc.setMailSettings({ user: "  ", from: "", port: null });
    expect(update.mock.calls[0][0].data).toEqual({ mailUser: null, mailFrom: null, mailPort: null });
  });

  it("refuses smtp without a host and resend without a key (no half-saved provider)", async () => {
    const none = { ...ROW, mailProvider: "none", mailHost: null, mailResendKeyEnc: null };
    const { svc, update } = make({ findUnique: jest.fn().mockResolvedValue(none) });
    await expect(svc.setMailSettings({ provider: "smtp" })).rejects.toThrow(/SMTP host/);
    await expect(svc.setMailSettings({ provider: "resend" })).rejects.toThrow(/Resend API key/);
    expect(update).not.toHaveBeenCalled();
  });

  it("allows switching to resend when a key is already stored (kept) or supplied now", async () => {
    const stored = { ...ROW, mailProvider: "smtp", mailFrom: "s@d.co", mailResendKeyEnc: "ENC(re)" };
    const { svc } = make({ findUnique: jest.fn().mockResolvedValue(stored), update: jest.fn().mockResolvedValue({ ...stored, mailProvider: "resend" }) });
    await expect(svc.setMailSettings({ provider: "resend" })).resolves.toMatchObject({ provider: "resend", hasResendKey: true });
  });

  it("refuses a real provider with no sender (From) — never a 'configured' mailer that silently never delivers", async () => {
    const stored = { ...ROW, mailProvider: "none", mailHost: "h.example.com", mailResendKeyEnc: "ENC(re)", mailFrom: null };
    const { svc, update } = make({ findUnique: jest.fn().mockResolvedValue(stored), update: jest.fn().mockResolvedValue({ ...stored, mailProvider: "smtp", mailFrom: "ops@acme.io" }) });
    await expect(svc.setMailSettings({ provider: "smtp" })).rejects.toThrow(/sender .*From.* required/i);
    await expect(svc.setMailSettings({ provider: "resend" })).rejects.toThrow(/sender .*From.* required/i);
    expect(update).not.toHaveBeenCalled();
    // supplying a From in the same patch is accepted
    await expect(svc.setMailSettings({ provider: "smtp", from: "ops@acme.io" })).resolves.toMatchObject({ provider: "smtp" });
  });

  it("switching provider to none is always allowed (back to the env fallback)", async () => {
    const { svc } = make({ findUnique: jest.fn().mockResolvedValue({ ...ROW, mailProvider: "smtp", mailHost: null }), update: jest.fn().mockResolvedValue({ ...ROW, mailProvider: "none" }) });
    await expect(svc.setMailSettings({ provider: "none" })).resolves.toMatchObject({ provider: "none" });
  });
});

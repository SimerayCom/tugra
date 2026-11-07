import type { ConfigService } from "@nestjs/config";
import { MailService } from "./mail.service";
import type { InstanceSettingsService } from "../instance/instance-settings.service";
import type { CryptoService } from "../crypto/crypto.service";
import nodemailer from "nodemailer";

jest.mock("nodemailer");

const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
(nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });

function cfg(env: Record<string, string | number>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

const NONE_ROW: Record<string, unknown> = { mailProvider: "none", mailHost: null, mailPort: null, mailSecure: false, mailUser: null, mailPassEnc: null, mailFrom: null, mailResendKeyEnc: null };

/** A fake CryptoService where "ENC(x)" decrypts to "x". */
const crypto = { decrypt: (s: string) => s.replace(/^ENC\((.*)\)$/, "$1") } as unknown as CryptoService;

function make(env: Record<string, string | number>, row: Record<string, unknown> = NONE_ROW) {
  const current = { row: { ...NONE_ROW, ...row } };
  const get = jest.fn().mockImplementation(() => Promise.resolve(current.row));
  const settings = { get } as unknown as InstanceSettingsService;
  return { svc: new MailService(cfg(env), settings, crypto), current, get };
}

const email = { subject: "Hi", html: "<p>hi</p>", text: "hi" };

describe("MailService", () => {
  beforeEach(() => {
    sendMail.mockReset().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockClear();
  });

  it("isConfigured reflects MAIL_HOST presence (env fallback)", () => {
    expect(make({}).svc.isConfigured()).toBe(false);
    expect(make({ MAIL_HOST: "smtp.example.com" }).svc.isConfigured()).toBe(true);
  });

  it("send() is fail-soft when unconfigured: returns false, does not throw, no transport", async () => {
    const { svc } = make({});
    await expect(svc.send("a@b.com", email)).resolves.toBe(false);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("send() dispatches via env SMTP with the configured from/to/subject/html/text when provider=none", async () => {
    const { svc } = make({ MAIL_HOST: "smtp.example.com", MAIL_PORT: 587, MAIL_SECURE: "false", MAIL_USER: "u", MAIL_PASS: "p", MAIL_FROM: "Tugra <no-reply@x>" });
    await expect(svc.send("a@b.com", email)).resolves.toBe(true);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.example.com", port: 587, secure: false, auth: { user: "u", pass: "p" } }),
    );
    expect(sendMail).toHaveBeenCalledWith({ from: "Tugra <no-reply@x>", to: "a@b.com", subject: "Hi", html: "<p>hi</p>", text: "hi" });
    expect(svc.source()).toBe("env");
  });

  it("send() returns false (never throws) when the transport errors", async () => {
    sendMail.mockRejectedValueOnce(new Error("connection refused"));
    const { svc } = make({ MAIL_HOST: "smtp.example.com" });
    await expect(svc.send("a@b.com", email)).resolves.toBe(false);
  });

  it("omits auth when no MAIL_USER is set", async () => {
    const { svc } = make({ MAIL_HOST: "smtp.example.com" });
    await svc.send("a@b.com", email);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ auth: undefined }));
  });

  describe("DB settings vs env", () => {
    const ENV = { MAIL_HOST: "env.example.com", MAIL_PORT: 25, MAIL_USER: "envu", MAIL_PASS: "envp", MAIL_FROM: "Env <env@x>" };

    it("prefers the DB SMTP settings over MAIL_* env (decrypting the password inside the service)", async () => {
      const { svc } = make(ENV, { mailProvider: "smtp", mailHost: "db.example.com", mailPort: 2525, mailSecure: true, mailUser: "dbu", mailPassEnc: "ENC(dbpass)", mailFrom: "Db <db@x>" });
      await expect(svc.send("a@b.com", email)).resolves.toBe(true);
      expect(nodemailer.createTransport).toHaveBeenCalledWith({ host: "db.example.com", port: 2525, secure: true, auth: { user: "dbu", pass: "dbpass" } });
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: "Db <db@x>" }));
      expect(svc.source()).toBe("db");
    });

    it("isConfigured() is true from DB settings alone (no MAIL_HOST) after a refresh", async () => {
      const { svc } = make({}, { mailProvider: "smtp", mailHost: "db.example.com" });
      expect(svc.isConfigured()).toBe(false); // nothing loaded yet → env
      await svc.refresh();
      expect(svc.isConfigured()).toBe(true);
    });

    it("falls back to env when provider=none even if stale DB fields are present", async () => {
      const { svc } = make(ENV, { mailProvider: "none", mailHost: "db.example.com", mailPassEnc: "ENC(x)" });
      await svc.send("a@b.com", email);
      expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: "env.example.com", port: 25, auth: { user: "envu", pass: "envp" } }));
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: "Env <env@x>" }));
      expect(svc.source()).toBe("env");
    });

    it("uses the env from address when the DB from is unset", async () => {
      const { svc } = make(ENV, { mailProvider: "smtp", mailHost: "db.example.com", mailFrom: null });
      await svc.send("a@b.com", email);
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: "Env <env@x>" }));
    });

    it("Resend is a preset SMTP transport (smtp.resend.com:465 secure, user 'resend', pass = API key)", async () => {
      const { svc } = make({}, { mailProvider: "resend", mailResendKeyEnc: "ENC(re_abc123)", mailFrom: "Tugra <hi@acme.io>" });
      await expect(svc.send("a@b.com", email)).resolves.toBe(true);
      expect(nodemailer.createTransport).toHaveBeenCalledWith({ host: "smtp.resend.com", port: 465, secure: true, auth: { user: "resend", pass: "re_abc123" } });
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: "Tugra <hi@acme.io>" }));
    });

    it("a half-configured provider (smtp w/o host, resend w/o key) falls through to env/none", async () => {
      expect((await (async () => { const m = make({}, { mailProvider: "smtp", mailHost: null }); await m.svc.refresh(); return m.svc.isConfigured(); })())).toBe(false);
      expect((await (async () => { const m = make({}, { mailProvider: "resend", mailResendKeyEnc: null }); await m.svc.refresh(); return m.svc.isConfigured(); })())).toBe(false);
    });

    it("rebuilds the cached transport when the settings change, reuses it when they do not", async () => {
      const { svc, current } = make({}, { mailProvider: "smtp", mailHost: "a.example.com", mailPassEnc: "ENC(p1)", mailUser: "u" });
      await svc.send("a@b.com", email);
      await svc.send("a@b.com", email);
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
      current.row = { ...current.row, mailHost: "b.example.com", mailPassEnc: "ENC(p2)" };
      await svc.send("a@b.com", email);
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(2);
      expect(nodemailer.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ host: "b.example.com", auth: { user: "u", pass: "p2" } }));
    });

    it("falls back to env when the settings read fails (never throws)", async () => {
      const { svc, get } = make(ENV);
      get.mockRejectedValue(new Error("db down"));
      await expect(svc.send("a@b.com", email)).resolves.toBe(true);
      expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: "env.example.com" }));
    });
  });

  describe("sendTest", () => {
    it("reports ok on success", async () => {
      const { svc } = make({ MAIL_HOST: "smtp.example.com" });
      await expect(svc.sendTest("me@x.io")).resolves.toEqual({ ok: true });
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "me@x.io", subject: "Tugra test email" }));
    });

    it("reports 'not configured' when nothing is configured", async () => {
      const { svc } = make({});
      await expect(svc.sendTest("me@x.io")).resolves.toEqual({ ok: false, reason: "mail is not configured" });
    });

    it("returns a short reason on failure and NEVER echoes the stored password / API key", async () => {
      sendMail.mockRejectedValueOnce(new Error("Invalid login: 535 bad credentials for pass s3cr3t-pw"));
      const { svc } = make({}, { mailProvider: "smtp", mailHost: "h.example.com", mailUser: "u", mailPassEnc: "ENC(s3cr3t-pw)" });
      const res = await svc.sendTest("me@x.io");
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("Invalid login");
      expect(res.reason).not.toContain("s3cr3t-pw");
      expect(res.reason).toContain("***");
    });

    it("scrubs the env password too and caps the reason length", async () => {
      sendMail.mockRejectedValueOnce(new Error(`envp ${"x".repeat(500)}`));
      const { svc } = make({ MAIL_HOST: "h", MAIL_USER: "u", MAIL_PASS: "envp" });
      const res = await svc.sendTest("me@x.io");
      expect(res.reason).not.toContain("envp");
      expect(res.reason!.length).toBeLessThanOrEqual(200);
    });
  });
});

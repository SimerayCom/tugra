import type { ConfigService } from "@nestjs/config";
import { MailService } from "./mail.service";
import nodemailer from "nodemailer";

jest.mock("nodemailer");

const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
(nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });

function cfg(env: Record<string, string | number>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

const email = { subject: "Hi", html: "<p>hi</p>", text: "hi" };

describe("MailService", () => {
  beforeEach(() => {
    sendMail.mockClear();
    (nodemailer.createTransport as jest.Mock).mockClear();
  });

  it("isConfigured reflects MAIL_HOST presence", () => {
    expect(new MailService(cfg({})).isConfigured()).toBe(false);
    expect(new MailService(cfg({ MAIL_HOST: "smtp.example.com" })).isConfigured()).toBe(true);
  });

  it("send() is fail-soft when unconfigured: returns false, does not throw, no transport", async () => {
    const svc = new MailService(cfg({}));
    await expect(svc.send("a@b.com", email)).resolves.toBe(false);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("send() dispatches via SMTP with the configured from/to/subject/html/text", async () => {
    const svc = new MailService(cfg({ MAIL_HOST: "smtp.example.com", MAIL_PORT: 587, MAIL_SECURE: "false", MAIL_USER: "u", MAIL_PASS: "p", MAIL_FROM: "Tugra <no-reply@x>" }));
    await expect(svc.send("a@b.com", email)).resolves.toBe(true);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.example.com", port: 587, secure: false, auth: { user: "u", pass: "p" } }),
    );
    expect(sendMail).toHaveBeenCalledWith({ from: "Tugra <no-reply@x>", to: "a@b.com", subject: "Hi", html: "<p>hi</p>", text: "hi" });
  });

  it("send() returns false (never throws) when the transport errors", async () => {
    sendMail.mockRejectedValueOnce(new Error("connection refused"));
    const svc = new MailService(cfg({ MAIL_HOST: "smtp.example.com" }));
    await expect(svc.send("a@b.com", email)).resolves.toBe(false);
  });

  it("omits auth when no MAIL_USER is set", async () => {
    const svc = new MailService(cfg({ MAIL_HOST: "smtp.example.com" }));
    await svc.send("a@b.com", email);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ auth: undefined }));
  });
});

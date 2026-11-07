import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import nodemailer, { type Transporter } from "nodemailer";
import type { InstanceSettings } from "@prisma/client";
import { CryptoService } from "../crypto/crypto.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { mailTestEmail, type RenderedEmail } from "./templates";

/** Resend exposes an SMTP relay, so it is a preset nodemailer transport (no extra HTTP client). */
const RESEND = { host: "smtp.resend.com", port: 465, secure: true, user: "resend" } as const;
const DEFAULT_FROM = "Tugra <no-reply@localhost>";
/** How long a loaded DB config is trusted by the sync isConfigured() before a background re-read. */
const STALE_MS = 30_000;

/** The effective mail config. `passEnc` is DB ciphertext (decrypted only when a transport is built);
 *  `pass` is the plaintext env value. `source` says where it came from. */
interface EffectiveMail {
  source: "db" | "env" | "none";
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  passEnc?: string;
  from: string;
}

export type MailSource = EffectiveMail["source"];

/**
 * Transactional mailer. The effective SMTP config is the owner's in-panel Email settings (InstanceSettings,
 * provider "smtp" | "resend") when set, else the MAIL_* env (unchanged fallback). When neither is configured
 * the mailer is FAIL-SOFT: `isConfigured()` is false and `send()` logs + returns false without throwing —
 * callers (password reset, verification, invites) then log the link to the hub server console (docker logs)
 * and still return 200, so a hub with no SMTP configured stays fully usable.
 *
 * Secrets: the DB password / Resend key are decrypted ONLY here, only when the transport is (re)built, and are
 * never logged or returned. The transport is cached against the raw config so a settings change rebuilds it.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transport: Transporter | null = null;
  private transportKey = "";
  /** Last DB-resolved config (null until first load → env is used meanwhile). */
  private effective: EffectiveMail | null = null;
  private loadedAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly settings: InstanceSettingsService,
    private readonly crypto: CryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  private envConfig(): EffectiveMail {
    const host = this.config.get<string>("MAIL_HOST");
    return {
      source: host ? "env" : "none",
      host: host || undefined,
      port: Number(this.config.get<number>("MAIL_PORT") ?? 587),
      secure: this.config.get<string>("MAIL_SECURE") === "true",
      user: this.config.get<string>("MAIL_USER") || undefined,
      pass: this.config.get<string>("MAIL_PASS") ?? "",
      from: this.config.get<string>("MAIL_FROM") ?? DEFAULT_FROM,
    };
  }

  /** DB settings win when the provider is selected AND usable; otherwise the env fallback. */
  private resolve(row: InstanceSettings): EffectiveMail {
    const env = this.envConfig();
    const from = row.mailFrom || env.from;
    if (row.mailProvider === "smtp" && row.mailHost) {
      return {
        source: "db",
        host: row.mailHost,
        port: row.mailPort ?? 587,
        secure: row.mailSecure,
        user: row.mailUser || undefined,
        passEnc: row.mailPassEnc || undefined,
        from,
      };
    }
    if (row.mailProvider === "resend" && row.mailResendKeyEnc) {
      return { source: "db", ...RESEND, passEnc: row.mailResendKeyEnc, from };
    }
    return env;
  }

  /** Re-read the DB mail settings (called at boot, after the owner saves, and before each send). Never
   *  throws: on a read failure the env fallback is used. */
  async refresh(): Promise<void> {
    try {
      this.effective = this.resolve(await this.settings.get());
    } catch (e) {
      this.effective = null;
      this.logger.warn(`could not load mail settings, using env fallback: ${e instanceof Error ? e.message : e}`);
    }
    this.loadedAt = Date.now();
  }

  private current(): EffectiveMail {
    return this.effective ?? this.envConfig();
  }

  /** Where the effective config comes from — "db" (panel settings), "env" (MAIL_*) or "none". */
  source(): MailSource {
    return this.current().source;
  }

  isConfigured(): boolean {
    // Sync API for callers; keep the cached DB view fresh in the background when it has gone stale.
    if (Date.now() - this.loadedAt > STALE_MS) {
      this.loadedAt = Date.now();
      void this.refresh();
    }
    return this.current().source !== "none";
  }

  private getTransport(cfg: EffectiveMail): Transporter {
    const key = JSON.stringify([cfg.source, cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass, cfg.passEnc]);
    if (!this.transport || this.transportKey !== key) {
      const pass = cfg.passEnc ? this.crypto.decrypt(cfg.passEnc) : (cfg.pass ?? "");
      this.transport = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass } : undefined,
      });
      this.transportKey = key;
    }
    return this.transport;
  }

  /** Strip any secret that might be echoed in a provider's error text, and cap the length. */
  private scrub(msg: string, cfg: EffectiveMail): string {
    let out = msg;
    const secrets: string[] = [];
    try {
      if (cfg.passEnc) secrets.push(this.crypto.decrypt(cfg.passEnc));
    } catch {
      /* undecryptable ciphertext: nothing to scrub */
    }
    if (cfg.pass) secrets.push(cfg.pass);
    for (const s of secrets) if (s) out = out.split(s).join("***");
    return out.replace(/\s+/g, " ").trim().slice(0, 200);
  }

  /** Dispatch + report why it failed (reason never contains a secret). Shared by send() and the test action. */
  private async deliver(to: string, email: RenderedEmail): Promise<{ ok: boolean; reason?: string }> {
    await this.refresh();
    const cfg = this.current();
    if (cfg.source === "none") {
      this.logger.warn(`mailer not configured (no panel Email settings and no MAIL_HOST) — skipped "${email.subject}" to ${to}`);
      return { ok: false, reason: "mail is not configured" };
    }
    try {
      await this.getTransport(cfg).sendMail({ from: cfg.from, to, subject: email.subject, html: email.html, text: email.text });
      return { ok: true };
    } catch (e) {
      // A transport failure must not break the auth flow — log (scrubbed) and let the caller fall back.
      const reason = this.scrub(e instanceof Error ? e.message : String(e), cfg);
      this.logger.error(`failed to send "${email.subject}" to ${to}: ${reason}`);
      return { ok: false, reason };
    }
  }

  /** Send a rendered template. Returns true if actually dispatched, false if fail-soft
   *  (mailer unconfigured) or on a transport error — never throws. */
  async send(to: string, email: RenderedEmail): Promise<boolean> {
    return (await this.deliver(to, email)).ok;
  }

  /** Owner "Send test email": uses the EFFECTIVE config; returns ok + a short scrubbed reason. Never throws. */
  async sendTest(to: string): Promise<{ ok: boolean; reason?: string }> {
    return this.deliver(to, mailTestEmail());
  }
}

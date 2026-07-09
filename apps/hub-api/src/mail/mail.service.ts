import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import nodemailer, { type Transporter } from "nodemailer";
import type { RenderedEmail } from "./templates";

/**
 * Transactional mailer. Reads SMTP config from env (MAIL_*). When MAIL_HOST is unset the
 * mailer is FAIL-SOFT: `isConfigured()` is false and `send()` logs + returns false without
 * throwing — callers (password reset, verification, invites) then fall back to an audit
 * log and still return 200, so a hub with no SMTP configured stays fully usable.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transport: Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.config.get<string>("MAIL_HOST");
  }

  private getTransport(): Transporter {
    if (!this.transport) {
      const user = this.config.get<string>("MAIL_USER");
      this.transport = nodemailer.createTransport({
        host: this.config.get<string>("MAIL_HOST"),
        port: this.config.get<number>("MAIL_PORT") ?? 587,
        secure: this.config.get<string>("MAIL_SECURE") === "true",
        auth: user ? { user, pass: this.config.get<string>("MAIL_PASS") ?? "" } : undefined,
      });
    }
    return this.transport;
  }

  /** Send a rendered template. Returns true if actually dispatched, false if fail-soft
   *  (mailer unconfigured) or on a transport error — never throws. */
  async send(to: string, email: RenderedEmail): Promise<boolean> {
    if (!this.isConfigured()) {
      this.logger.warn(`mailer not configured (no MAIL_HOST) — skipped "${email.subject}" to ${to}`);
      return false;
    }
    try {
      await this.getTransport().sendMail({
        from: this.config.get<string>("MAIL_FROM") ?? "Tugra <no-reply@localhost>",
        to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      return true;
    } catch (e) {
      // A transport failure must not break the auth flow — log and let the caller fall back.
      this.logger.error(`failed to send "${email.subject}" to ${to}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }
}

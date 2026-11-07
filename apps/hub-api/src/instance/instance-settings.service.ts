import { BadRequestException, Injectable } from "@nestjs/common";
import { InstanceSettings, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { currentEdition, editionAtLeast } from "../common/edition";
import { CryptoService } from "../crypto/crypto.service";

const SINGLETON = "singleton";

/** Public white-label view. All null + hidePoweredBy=false means "show the Tugra defaults". */
export interface BrandingView {
  name: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  accentColor: string | null;
  hidePoweredBy: boolean;
}

/** Owner-facing mail config. NEVER carries a secret — only whether one is stored. */
export interface MailSettingsView {
  provider: "none" | "smtp" | "resend";
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  from: string | null;
  hasPassword: boolean;
  hasResendKey: boolean;
}

/** Partial patch for setMailSettings. `password` / `resendKey` are write-only (blank/undefined = keep). */
export interface MailSettingsPatch {
  provider?: "none" | "smtp" | "resend";
  host?: string | null;
  port?: number | null;
  secure?: boolean;
  user?: string | null;
  from?: string | null;
  password?: string;
  resendKey?: string;
}

const TUGRA_DEFAULTS: BrandingView = { name: null, logoUrl: null, faviconUrl: null, accentColor: null, hidePoweredBy: false };

/**
 * The single-row instance-level settings (onboarding state, registration gating, edition, self-update,
 * API gating). Mirrors the CatalogSnapshot fixed-PK singleton pattern. The row is created lazily on first
 * access; `get()` is read-only in steady state (no write per call), so per-request consumers (e.g. API
 * gating) don't cause write amplification.
 */
@Injectable()
export class InstanceSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** The singleton settings row, created on first access. Read-only once it exists; race-safe. */
  async get(): Promise<InstanceSettings> {
    const existing = await this.prisma.instanceSettings.findUnique({ where: { id: SINGLETON } });
    if (existing) return existing;
    // First access (or a concurrent race): create it. `update: {}` makes the losing racer a no-op.
    return this.prisma.instanceSettings.upsert({ where: { id: SINGLETON }, create: { id: SINGLETON }, update: {} });
  }

  /** Patch the singleton (ensuring it exists first). Used by onboarding / registration-gating / settings. */
  async update(patch: Prisma.InstanceSettingsUpdateInput): Promise<InstanceSettings> {
    await this.get();
    return this.prisma.instanceSettings.update({ where: { id: SINGLETON }, data: patch });
  }

  /**
   * The ACME account email for issuing TLS certs: the env (ACME_EMAIL) wins, else the owner's onboarding
   * value (InstanceSettings.acmeEmail), else undefined (the proxy script then uses its placeholder). This
   * is what makes the onboarding "Let's Encrypt email" field actually drive cert issuance instead of being
   * silently ignored (so expiry notices reach a real inbox, not admin@example.com).
   */
  async acmeEmailFor(envEmail?: string): Promise<string | undefined> {
    if (envEmail && envEmail.trim()) return envEmail.trim();
    const s = await this.get();
    return s.acmeEmail ?? undefined;
  }

  /**
   * The effective panel-TLS hostname (DİLİM 1), or null when panel TLS is off. The env wins — PANEL_TLS="1"
   * + PANEL_DOMAIN (written by install.sh --auto-tls) overrides the DB — else the owner's stored
   * InstanceSettings.panelDomain. Mirrors acmeEmailFor's env-over-DB precedence. Null = bring-your-own proxy.
   */
  async panelDomainFor(envDomain?: string, envFlag?: string): Promise<string | null> {
    if (envFlag === "1" && envDomain && envDomain.trim()) return envDomain.trim();
    const s = await this.get();
    return s.panelDomain ?? null;
  }

  /**
   * The effective white-label branding, safe to expose publicly (login page themes pre-auth). Branding is a
   * PRO feature, so it is applied ONLY while the instance is Pro+ — a Community or lapsed-license instance
   * always gets the Tugra defaults, which is what enforces the paywall at read time (a stored brand can't
   * keep applying after a license lapses, and can't be set at all below Pro since the PATCH is gated too).
   */
  async effectiveBranding(): Promise<BrandingView> {
    if (!editionAtLeast(currentEdition(), "pro")) return TUGRA_DEFAULTS;
    const s = await this.get();
    return {
      name: s.brandName,
      logoUrl: s.brandLogoUrl,
      faviconUrl: s.brandFaviconUrl,
      accentColor: s.brandAccentColor,
      hidePoweredBy: s.brandHidePoweredBy,
    };
  }
  private mailView(s: InstanceSettings): MailSettingsView {
    return {
      provider: (["smtp", "resend"].includes(s.mailProvider) ? s.mailProvider : "none") as MailSettingsView["provider"],
      host: s.mailHost,
      port: s.mailPort,
      secure: s.mailSecure,
      user: s.mailUser,
      from: s.mailFrom,
      hasPassword: !!s.mailPassEnc,
      hasResendKey: !!s.mailResendKeyEnc,
    };
  }

  /** The owner-visible mail config. Secrets are NEVER returned — only `hasPassword` / `hasResendKey`. */
  async getMailSettings(): Promise<MailSettingsView> {
    return this.mailView(await this.get());
  }

  /**
   * Persist the mail config (owner-gated at the controller). Text fields: "" / null clears. Secrets are
   * write-only with replace semantics — a non-empty `password` / `resendKey` is encrypted (CryptoService) and
   * stored; blank/undefined leaves the stored ciphertext untouched. Refuses to leave the provider selected but
   * unusable (smtp needs a host; resend needs a key), so a half-saved form can't silently disable mail.
   */
  async setMailSettings(patch: MailSettingsPatch): Promise<MailSettingsView> {
    const current = await this.get();
    const data: Prisma.InstanceSettingsUpdateInput = {};
    const text = (v: string | null | undefined) => (v == null ? null : v.trim() || null);
    if (patch.provider !== undefined) data.mailProvider = patch.provider;
    if (patch.host !== undefined) data.mailHost = text(patch.host);
    if (patch.port !== undefined) data.mailPort = patch.port;
    if (patch.secure !== undefined) data.mailSecure = patch.secure;
    if (patch.user !== undefined) data.mailUser = text(patch.user);
    if (patch.from !== undefined) data.mailFrom = text(patch.from);
    if (patch.password) data.mailPassEnc = this.crypto.encrypt(patch.password);
    if (patch.resendKey) data.mailResendKeyEnc = this.crypto.encrypt(patch.resendKey);

    const provider = patch.provider ?? this.mailView(current).provider;
    const host = data.mailHost !== undefined ? data.mailHost : current.mailHost;
    const from = data.mailFrom !== undefined ? (data.mailFrom as string | null) : current.mailFrom;
    const hasKey = data.mailResendKeyEnc !== undefined ? true : !!current.mailResendKeyEnc;
    if (provider === "smtp" && !host) throw new BadRequestException("an SMTP host is required");
    if (provider === "resend" && !hasKey) throw new BadRequestException("a Resend API key is required");
    // A provider with no sender reports "configured" yet silently never delivers (Resend rejects the localhost
    // fallback) — the exact confusing state we're removing. Require a From for any real provider.
    if ((provider === "smtp" || provider === "resend") && !from)
      throw new BadRequestException("a sender (From) address is required so mail can be delivered");

    return this.mailView(await this.update(data));
  }
}

import { BadRequestException, Body, ConflictException, Controller, Get, Header, HttpCode, type MessageEvent, Param, Patch, Post, Req, Sse, UseGuards } from "@nestjs/common";
import { distinctUntilChanged, from, interval, map, mergeMap, type Observable, takeWhile } from "rxjs";
import { ApiTags, ApiCookieAuth } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { AuditService } from "../audit/audit.service";
import { InstanceSettingsService } from "./instance-settings.service";
import { InstanceOwnerGuard } from "./instance-owner.guard";
import { currentEdition, RequireEdition, RequireEditionGuard } from "../common/edition";
import { AUTO_UPDATE_CHANNEL } from "@tugra/shared";
import { CryptoService } from "../crypto/crypto.service";
import { SecretsRotationService } from "../crypto/secrets-rotation.service";
import { KeyRingService } from "../crypto/keyring.service";
import { RotateSecretsKeySchema, SecretsKeyIdParamSchema, type RotateSecretsKeyInput } from "./secrets-key.dto";
import { assertSafeUrl, allowPrivateTargets } from "../notifications/safe-url";
import { LicenseService } from "../license/license.service";
import {
  LicenseInput,
  LicenseSchema,
  OidcConfigInput,
  OidcConfigSchema,
  UpdateInstanceSettingsInput,
  UpdateInstanceSettingsSchema,
  UpdateInstanceUpdateInput,
  UpdateInstanceUpdateSchema,
  UpdateTelemetryInput,
  UpdateTelemetrySchema,
  UpdateBrandingInput,
  UpdateBrandingSchema,
  UpdateMailSettingsInput,
  UpdateMailSettingsSchema,
  MailTestInput,
  MailTestSchema,
} from "./dto";
import { MailService } from "../mail/mail.service";
import { UpdateService } from "../update/update.service";
import { UpdaterService, isTerminalPhase } from "../update/updater.service";
import { StackConvergeService } from "../update/stack-converge.service";
import { OwnerUpdateStatusViewSchema, UpdateApplyResultSchema } from "../update/dto";
import { TelemetryService } from "../telemetry/telemetry.service";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "../auth/auth.service";
import { TwoFactorPolicyService } from "../auth/two-factor-policy.service";
import { publicUrlFrom, type ReqLike } from "../common/hub-url";
import { suggestOnboardingDefaults } from "./onboarding-defaults";

/**
 * Owner-only instance settings, managed with the login SESSION (JwtAuthGuard, not ApiAuthGuard) — like API
 * token management. Being session-only means a PAT can't reach it AND it isn't subject to the API gating it
 * configures, so an owner can never lock themselves out (the web always works to re-enable the API).
 */
@ApiTags("instance")
@ApiCookieAuth("session")
@Controller("instance")
@UseGuards(JwtAuthGuard, InstanceOwnerGuard, RequireEditionGuard)
export class InstanceSettingsController {
  constructor(
    private readonly settings: InstanceSettingsService,
    private readonly audit: AuditService,
    private readonly update: UpdateService,
    private readonly updater: UpdaterService,
    private readonly crypto: CryptoService,
    private readonly license: LicenseService,
    private readonly telemetry: TelemetryService,
    private readonly mail: MailService,
    private readonly rotation: SecretsRotationService,
    private readonly keyring: KeyRingService,
    private readonly converge: StackConvergeService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly twoFactorPolicy: TwoFactorPolicyService,
  ) {}

  /** The update status plus the update helper's own version (read from Redis, never from docker). */
  private async updateView() {
    return { ...(await this.update.getStatus()), updater: await this.converge.view(), halfUpdate: await this.updater.getHalfUpdate() };
  }

  /**
   * Master-key rotation status (owner-only, session-only): which key is current, which previous keys are still
   * configured, and how many stored secrets are not yet under the current key. Never returns a key or a secret.
   */
  @Get("secrets-key")
  @Header("Cache-Control", "no-store")
  secretsKeyStatus() {
    return this.keyring.statusView();
  }

  /**
   * Rotate the secrets encryption key with no restart: a new random data key becomes active (wrapped under the
   * unchanged .env root key), and by default the re-encrypt job starts. `expectedCurrentKeyId` guards against a stale
   * page (409 stale_current). Machine codes: ring_degraded, rotation_running, stale_current, already_env_root.
   */
  @Post("secrets-key/rotate")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  @ApiZodBody(RotateSecretsKeySchema)
  rotateSecretsKey(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(RotateSecretsKeySchema)) body: RotateSecretsKeyInput) {
    return this.keyring.rotate(user.userId, body);
  }

  /** Retire a decrypt-only data key nothing references any more (reversible: Restore). */
  @Post("secrets-key/keys/:keyId/retire")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  retireSecretsKey(@CurrentUser() user: AuthUser, @Param("keyId", new ZodValidationPipe(SecretsKeyIdParamSchema)) keyId: string) {
    return this.keyring.retire(user.userId, keyId);
  }

  /** Bring a retired data key back as decrypt-only (when a configured root key can still unwrap it). */
  @Post("secrets-key/keys/:keyId/restore")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  restoreSecretsKey(@CurrentUser() user: AuthUser, @Param("keyId", new ZodValidationPipe(SecretsKeyIdParamSchema)) keyId: string) {
    return this.keyring.restore(user.userId, keyId);
  }

  /** Re-encrypt every stored secret under the CURRENT key (detached; poll the status). 409 while one runs. */
  @Post("secrets-key/reencrypt")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  async reencryptSecrets(@CurrentUser() user: AuthUser) {
    const run = this.rotation.start(user.userId);
    try {
      await this.audit.log({ actor: user.userId, action: "instance.secrets_key.reencrypt_start", target: "singleton" });
    } catch {
      /* best-effort: the run is already going (its completion is audited too); never turn a started run into a 500 */
    }
    return { startedAt: run.startedAt };
  }

  /**
   * Self-update status: the running version, the latest published version for the tracked channel (from
   * the last signed check — cached, no remote fetch on this path), and whether an update is available.
   * `updateAvailable` is computed against the running build, so an older/stale manifest never suggests a
   * downgrade. Owner-only (inherits the class guards); nothing is applied here.
   */
  @Get("update")
  @ApiZodResponse(OwnerUpdateStatusViewSchema)
  async getUpdate() {
    const status = await this.updateView();
    // Opening the panel is the moment an owner cares: kick a background refresh when the last check is stale.
    // Fire-and-forget — the request never waits on the network, and this path never applies an update.
    this.update.refreshIfStale(status.lastCheckedAt);
    // Same moment: let the hub look at the update helper (and bring it forward when it lags). Throttled, background.
    this.converge.reconcileIfStale();
    return status;
  }

  /**
   * Set the self-update preferences (channel + auto-update). Fast — it does NOT fetch the remote manifest
   * (that could hang the request), so after changing the channel the caller should trigger a check
   * (POST update/check) to refresh the cached "latest" for the new channel. autoUpdate is recorded but the
   * apply step is not available yet.
   */
  @Patch("update")
  @ApiZodBody(UpdateInstanceUpdateSchema)
  @ApiZodResponse(OwnerUpdateStatusViewSchema)
  async setUpdate(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateInstanceUpdateSchema)) body: UpdateInstanceUpdateInput,
  ) {
    const patch: { autoUpdate?: boolean; updateChannel?: string } = {};
    if (body.autoUpdate !== undefined) patch.autoUpdate = body.autoUpdate;
    // null on the wire = "follow the build"; stored as the "auto" sentinel (the column stays non-null so an
    // older hub image can still read the row after a rollback).
    if (body.updateChannel !== undefined) patch.updateChannel = body.updateChannel ?? AUTO_UPDATE_CHANNEL;
    await this.settings.update(patch);
    await this.audit.log({ actor: user.userId, action: "instance_update.settings", target: "singleton" });
    return this.updateView();
  }

  /** Manually re-check the signed manifest now (the scheduler otherwise checks hourly). Never throws. */
  @Post("update/check")
  @HttpCode(200)
  @ApiZodResponse(OwnerUpdateStatusViewSchema)
  async checkUpdate() {
    await this.update.checkRemote();
    return this.updateView();
  }

  /**
   * Apply the available update now. Re-verifies the signed manifest, refuses any downgrade/channel-skip,
   * then queues the job for the `tugra-updater` sidecar (the hub can't recreate its own container). Returns
   * a typed status; 409 if an update is already running. Progress streams from GET update/stream.
   */
  @Post("update")
  @HttpCode(200)
  @ApiZodResponse(UpdateApplyResultSchema)
  async applyUpdate(@CurrentUser() user: AuthUser) {
    const res = await this.updater.requestUpdate({ actor: user.userId, auto: false });
    if (res.status === "in-progress") throw new ConflictException("an update is already in progress");
    if (res.status === "started") {
      await this.audit.log({ actor: user.userId, action: "instance_update.apply", target: "singleton" });
    }
    return res;
  }

  /**
   * Live update progress (SSE). Polls the Redis status the sidecar writes and completes on a terminal phase.
   * The connection drops when hub-api is recreated mid-update (expected) — the client reconnects/polls the
   * version. Owner-only via the class guards; the web authenticates with the same-origin session cookie.
   */
  @Sse("update/stream")
  streamUpdate(): Observable<MessageEvent> {
    return interval(1000).pipe(
      mergeMap(() => from(this.updater.getProgress())),
      distinctUntilChanged((a, b) => a.phase === b.phase && a.targetVersion === b.targetVersion && a.error === b.error && a.code === b.code),
      takeWhile((p) => !isTerminalPhase(p.phase), true), // inclusive: emit the terminal event, then complete
      map((p) => ({ data: JSON.stringify(p) }) as MessageEvent),
    );
  }

  @Get("settings")
  async getSettings(@CurrentUser() user: AuthUser, @Req() req: ReqLike) {
    const s = await this.settings.get();
    // `edition` is env/license-driven and read-only here (deliberately absent from PATCH) — surfacing it
    // lets the owner see their tier without being able to grant themselves a higher one. publicUrl/acmeEmail
    // are surfaced so the onboarding wizard can pre-fill them on resume; `suggested` carries what the installer
    // already knew (HUB_PUBLIC_URL / PANEL_DOMAIN / ACME_EMAIL / the owner's email) for the still-empty fields.
    const owner = await this.auth.me(user.userId);
    const suggested = suggestOnboardingDefaults({
      envPublicUrl: this.config.get<string>("HUB_PUBLIC_URL"),
      panelDomain: this.config.get<string>("PANEL_DOMAIN") || s.panelDomain || undefined,
      envAcmeEmail: this.config.get<string>("ACME_EMAIL"),
      requestUrl: publicUrlFrom(req),
      ownerEmail: owner.email,
    });
    return {
      apiEnabled: s.apiEnabled,
      apiAllowedIps: s.apiAllowedIps,
      publicUrl: s.publicUrl,
      acmeEmail: s.acmeEmail,
      require2fa: s.require2faForAdmins,
      suggested,
      edition: currentEdition(),
    };
  }

  @Patch("settings")
  @ApiZodBody(UpdateInstanceSettingsSchema)
  async updateSettings(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateInstanceSettingsSchema)) body: UpdateInstanceSettingsInput,
  ) {
    const patch: { apiEnabled?: boolean; apiAllowedIps?: string[]; publicUrl?: string | null; acmeEmail?: string | null; require2faForAdmins?: boolean } = {};
    if (body.apiEnabled !== undefined) patch.apiEnabled = body.apiEnabled;
    if (body.apiAllowedIps !== undefined) {
      patch.apiAllowedIps = body.apiAllowedIps.map((e) => e.trim()).filter(Boolean);
    }
    // Map a falsy value ("" or null) to null so the owner can CLEAR the field; a real value is stored as-is.
    if (body.publicUrl !== undefined) patch.publicUrl = body.publicUrl || null;
    if (body.acmeEmail !== undefined) patch.acmeEmail = body.acmeEmail || null;
    if (body.require2fa !== undefined) {
      // Never lock the owner out: the policy can only be switched ON by an owner who has 2FA themselves, so at
      // least one account always satisfies it (and everyone else is steered to enrol, never stranded).
      if (body.require2fa) {
        const me = await this.auth.me(user.userId);
        if (!me.twoFaEnabled) throw new BadRequestException("turn on two-factor authentication for your own account first");
      }
      patch.require2faForAdmins = body.require2fa;
    }
    const s = await this.settings.update(patch);
    if (body.require2fa !== undefined) this.twoFactorPolicy.invalidate();
    await this.audit.log({
      actor: user.userId,
      action: "instance_settings.update",
      target: "singleton",
      ...(body.require2fa !== undefined ? { meta: { require2fa: body.require2fa } } : {}),
    });
    return { apiEnabled: s.apiEnabled, apiAllowedIps: s.apiAllowedIps, publicUrl: s.publicUrl, acmeEmail: s.acmeEmail, require2fa: s.require2faForAdmins };
  }

  /**
   * OIDC single sign-on config (Pro). Owner-only (class guards) AND edition-gated (@RequireEdition("pro"))
   * — a Community instance gets a 403, so SSO cannot be configured below Pro. The client secret is NEVER
   * returned; `clientSecretSet` only reveals whether one is stored.
   */
  @Get("oidc")
  @RequireEdition("pro")
  async getOidc() {
    const s = await this.settings.get();
    return {
      oidcEnabled: s.oidcEnabled,
      oidcIssuer: s.oidcIssuer,
      oidcClientId: s.oidcClientId,
      oidcAllowedDomains: s.oidcAllowedDomains,
      clientSecretSet: !!s.oidcClientSecretEnc,
    };
  }

  @Patch("oidc")
  @RequireEdition("pro")
  @ApiZodBody(OidcConfigSchema)
  async updateOidc(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(OidcConfigSchema)) body: OidcConfigInput,
  ) {
    const current = await this.settings.get();
    const patch: {
      oidcEnabled?: boolean;
      oidcIssuer?: string | null;
      oidcClientId?: string | null;
      oidcClientSecretEnc?: string;
      oidcAllowedDomains?: string[];
    } = {};

    if (body.oidcEnabled !== undefined) patch.oidcEnabled = body.oidcEnabled;
    if (body.oidcIssuer !== undefined) {
      const issuer = body.oidcIssuer || null;
      if (issuer) {
        // The issuer is fetched server-side (discovery/token/JWKS) — reject internal/metadata targets to
        // avoid using SSO config as an SSRF primitive (self-hosters can opt in via NOTIFY_ALLOW_PRIVATE_TARGETS).
        try {
          await assertSafeUrl(issuer, { allowPrivate: allowPrivateTargets() });
        } catch {
          throw new BadRequestException("the issuer URL is not allowed (private/loopback/metadata address)");
        }
      }
      patch.oidcIssuer = issuer;
    }
    if (body.oidcClientId !== undefined) patch.oidcClientId = body.oidcClientId || null;
    // Write-only: only (re)encrypt when a new non-empty secret is supplied; otherwise keep the stored one.
    if (body.oidcClientSecret) patch.oidcClientSecretEnc = this.crypto.encrypt(body.oidcClientSecret);
    if (body.oidcAllowedDomains !== undefined) {
      patch.oidcAllowedDomains = body.oidcAllowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
    }

    // Refuse to leave SSO enabled-but-broken: enabling requires a full issuer + clientId + secret.
    const enabled = patch.oidcEnabled ?? current.oidcEnabled;
    const issuer = patch.oidcIssuer !== undefined ? patch.oidcIssuer : current.oidcIssuer;
    const clientId = patch.oidcClientId !== undefined ? patch.oidcClientId : current.oidcClientId;
    const secretSet = patch.oidcClientSecretEnc !== undefined ? true : !!current.oidcClientSecretEnc;
    if (enabled && (!issuer || !clientId || !secretSet)) {
      throw new BadRequestException("issuer, client ID and client secret are required to enable SSO");
    }

    const s = await this.settings.update(patch);
    await this.audit.log({ actor: user.userId, action: "instance_settings.oidc", target: "singleton" }); // secret never logged
    return {
      oidcEnabled: s.oidcEnabled,
      oidcIssuer: s.oidcIssuer,
      oidcClientId: s.oidcClientId,
      oidcAllowedDomains: s.oidcAllowedDomains,
      clientSecretSet: !!s.oidcClientSecretEnc,
    };
  }

  /**
   * Signed-license entitlement. Owner-only but deliberately NOT edition-gated — a Community instance must
   * be able to read its plan and paste a license to UPGRADE. The token is never returned (write-only);
   * `status()` reports only the effective plan, validity and expiry.
   */
  @Get("license")
  getLicense() {
    return this.license.status();
  }

  @Patch("license")
  @ApiZodBody(LicenseSchema)
  async updateLicense(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(LicenseSchema)) body: LicenseInput,
  ) {
    const token = body.token.trim();
    // Verify BEFORE persisting — an invalid/expired/forged token is rejected (400) and never stored, so a
    // bad paste can't silently sit in the DB. An empty token clears the license (downgrade).
    if (token) {
      try {
        await this.license.verifyToken(token);
      } catch {
        throw new BadRequestException("invalid or expired license");
      }
    }
    await this.settings.update({ licenseToken: token || null });
    await this.license.refresh(); // re-read + re-cache the effective edition (no restart needed)
    await this.audit.log({ actor: user.userId, action: "instance.license", target: "singleton", meta: { cleared: !token } }); // token never logged
    return this.license.status();
  }

  /**
   * Anonymous usage stats (ON by default, opt-out). Owner-only (class guards). Returns the effective state,
   * whether the env hard-off (TUGRA_TELEMETRY=0) is overriding the toggle, the anonymous instance id, the
   * last send time, the endpoint/interval AND a LIVE preview of the exact payload that would be sent — so
   * the owner can see, byte-for-byte, what leaves the box (there is no hidden field; no IP/host/domain/PII).
   */
  @Get("telemetry")
  async getTelemetry() {
    return this.telemetry.status();
  }

  /** Flip the owner-UI telemetry toggle. Has no effect while TUGRA_TELEMETRY=0 forces it off (env wins). */
  @Patch("telemetry")
  @ApiZodBody(UpdateTelemetrySchema)
  async setTelemetry(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateTelemetrySchema)) body: UpdateTelemetryInput,
  ) {
    await this.telemetry.setEnabled(body.enabled);
    await this.audit.log({ actor: user.userId, action: "instance.telemetry", target: "singleton", meta: { enabled: body.enabled } });
    return this.telemetry.status();
  }

  /** Send an anonymous stats ping now (owner "send now"). Never throws; returns the send outcome. */
  @Post("telemetry/send")
  @HttpCode(200)
  async sendTelemetry(@CurrentUser() user: AuthUser) {
    const res = await this.telemetry.sendNow();
    await this.audit.log({ actor: user.userId, action: "instance.telemetry_send", target: "singleton", meta: { result: res.status } });
    return res;
  }

  /** Rotate the anonymous instance id (owner "reset identity"). Returns the refreshed status. */
  @Post("telemetry/reset")
  @HttpCode(200)
  async resetTelemetry(@CurrentUser() user: AuthUser) {
    await this.telemetry.resetInstanceId();
    await this.audit.log({ actor: user.userId, action: "instance.telemetry_reset", target: "singleton" });
    return this.telemetry.status();
  }

  /**
   * White-label branding (Pro). Owner-only (class guards) AND edition-gated (@RequireEdition("pro") enforced
   * by the class-level RequireEditionGuard) — Community gets a 403, so a brand can't be set below Pro. Each
   * field is clearable: a falsy value maps to null (back to the Tugra default). Returns the effective
   * branding (which the public GET /instance/branding also serves, gated the same way).
   */
  @Patch("branding")
  @RequireEdition("pro")
  @ApiZodBody(UpdateBrandingSchema)
  async updateBranding(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateBrandingSchema)) body: UpdateBrandingInput,
  ) {
    const patch: { brandName?: string | null; brandLogoUrl?: string | null; brandFaviconUrl?: string | null; brandAccentColor?: string | null; brandHidePoweredBy?: boolean } = {};
    if (body.name !== undefined) patch.brandName = body.name || null;
    if (body.logoUrl !== undefined) patch.brandLogoUrl = body.logoUrl || null;
    if (body.faviconUrl !== undefined) patch.brandFaviconUrl = body.faviconUrl || null;
    if (body.accentColor !== undefined) patch.brandAccentColor = body.accentColor || null;
    if (body.hidePoweredBy !== undefined) patch.brandHidePoweredBy = body.hidePoweredBy;
    await this.settings.update(patch);
    await this.audit.log({ actor: user.userId, action: "instance.branding", target: "singleton" });
    return this.settings.effectiveBranding();
  }
  /**
   * In-panel Email (SMTP / Resend) settings. Owner-only (class guards). The SMTP password and Resend key are
   * write-only — the view carries only `hasPassword` / `hasResendKey`. `effective` says where the mailer is
   * actually reading its config from ("db" = these settings, "env" = MAIL_* fallback, "none" = unconfigured).
   */
  @Get("mail")
  async getMail() {
    await this.mail.refresh();
    return { ...(await this.settings.getMailSettings()), effective: this.mail.source() };
  }

  @Patch("mail")
  @ApiZodBody(UpdateMailSettingsSchema)
  async updateMail(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateMailSettingsSchema)) body: UpdateMailSettingsInput,
  ) {
    const view = await this.settings.setMailSettings(body);
    await this.mail.refresh(); // drop the cached effective config so the change applies immediately
    // Audit the provider only — never the host credentials or any secret.
    await this.audit.log({ actor: user.userId, action: "instance_settings.mail", target: "singleton", meta: { provider: view.provider } });
    return { ...view, effective: this.mail.source() };
  }

  /** Send a test email to `to` with the EFFECTIVE config. Always 200 with `{ok, reason?}`; the reason is scrubbed
   *  of secrets and capped, never the password / API key. */
  @Post("mail/test")
  @HttpCode(200)
  @ApiZodBody(MailTestSchema)
  async testMail(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(MailTestSchema)) body: MailTestInput,
  ) {
    const res = await this.mail.sendTest(body.to);
    await this.audit.log({ actor: user.userId, action: "instance_settings.mail_test", target: "singleton", meta: { ok: res.ok } });
    return res;
  }
}

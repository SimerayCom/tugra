import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, type MessageEvent, Patch, Post, Sse, UseGuards } from "@nestjs/common";
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
import { CryptoService } from "../crypto/crypto.service";
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
} from "./dto";
import { UpdateService } from "../update/update.service";
import { UpdaterService, isTerminalPhase } from "../update/updater.service";
import { UpdateApplyResultSchema, UpdateStatusViewSchema } from "../update/dto";
import { TelemetryService } from "../telemetry/telemetry.service";

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
  ) {}

  /**
   * Self-update status: the running version, the latest published version for the tracked channel (from
   * the last signed check — cached, no remote fetch on this path), and whether an update is available.
   * `updateAvailable` is computed against the running build, so an older/stale manifest never suggests a
   * downgrade. Owner-only (inherits the class guards); nothing is applied here.
   */
  @Get("update")
  @ApiZodResponse(UpdateStatusViewSchema)
  async getUpdate() {
    return this.update.getStatus();
  }

  /**
   * Set the self-update preferences (channel + auto-update). Fast — it does NOT fetch the remote manifest
   * (that could hang the request), so after changing the channel the caller should trigger a check
   * (POST update/check) to refresh the cached "latest" for the new channel. autoUpdate is recorded but the
   * apply step is not available yet.
   */
  @Patch("update")
  @ApiZodBody(UpdateInstanceUpdateSchema)
  @ApiZodResponse(UpdateStatusViewSchema)
  async setUpdate(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateInstanceUpdateSchema)) body: UpdateInstanceUpdateInput,
  ) {
    const patch: { autoUpdate?: boolean; updateChannel?: string } = {};
    if (body.autoUpdate !== undefined) patch.autoUpdate = body.autoUpdate;
    if (body.updateChannel !== undefined) patch.updateChannel = body.updateChannel;
    await this.settings.update(patch);
    await this.audit.log({ actor: user.userId, action: "instance_update.settings", target: "singleton" });
    return this.update.getStatus();
  }

  /** Manually re-check the signed manifest now (the scheduler otherwise checks daily). Never throws. */
  @Post("update/check")
  @HttpCode(200)
  @ApiZodResponse(UpdateStatusViewSchema)
  async checkUpdate() {
    await this.update.checkRemote();
    return this.update.getStatus();
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
      distinctUntilChanged((a, b) => a.phase === b.phase && a.targetVersion === b.targetVersion && a.error === b.error),
      takeWhile((p) => !isTerminalPhase(p.phase), true), // inclusive: emit the terminal event, then complete
      map((p) => ({ data: JSON.stringify(p) }) as MessageEvent),
    );
  }

  @Get("settings")
  async getSettings() {
    const s = await this.settings.get();
    // `edition` is env/license-driven and read-only here (deliberately absent from PATCH) — surfacing it
    // lets the owner see their tier without being able to grant themselves a higher one. publicUrl/acmeEmail
    // are surfaced so the onboarding wizard can pre-fill them on resume.
    return {
      apiEnabled: s.apiEnabled,
      apiAllowedIps: s.apiAllowedIps,
      publicUrl: s.publicUrl,
      acmeEmail: s.acmeEmail,
      edition: currentEdition(),
    };
  }

  @Patch("settings")
  @ApiZodBody(UpdateInstanceSettingsSchema)
  async updateSettings(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateInstanceSettingsSchema)) body: UpdateInstanceSettingsInput,
  ) {
    const patch: { apiEnabled?: boolean; apiAllowedIps?: string[]; publicUrl?: string | null; acmeEmail?: string | null } = {};
    if (body.apiEnabled !== undefined) patch.apiEnabled = body.apiEnabled;
    if (body.apiAllowedIps !== undefined) {
      patch.apiAllowedIps = body.apiAllowedIps.map((e) => e.trim()).filter(Boolean);
    }
    // Map a falsy value ("" or null) to null so the owner can CLEAR the field; a real value is stored as-is.
    if (body.publicUrl !== undefined) patch.publicUrl = body.publicUrl || null;
    if (body.acmeEmail !== undefined) patch.acmeEmail = body.acmeEmail || null;
    const s = await this.settings.update(patch);
    await this.audit.log({ actor: user.userId, action: "instance_settings.update", target: "singleton" });
    return { apiEnabled: s.apiEnabled, apiAllowedIps: s.apiAllowedIps, publicUrl: s.publicUrl, acmeEmail: s.acmeEmail };
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
}

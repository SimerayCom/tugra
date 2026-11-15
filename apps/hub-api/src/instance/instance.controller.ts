import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { InstanceSettingsService } from "./instance-settings.service";
import { MailService } from "../mail/mail.service";
import { UpdateService } from "../update/update.service";
import { MemberVersionViewSchema } from "../update/dto";
import { ApiZodResponse } from "../openapi/openapi";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { currentEdition, editionAtLeast } from "../common/edition";

/**
 * Public onboarding/instance status. No class-level `@UseGuards` → unauthenticated by default (auth is
 * opt-in per controller here), like Health/Version. The web root reads this before any login to decide
 * whether a fresh instance should show the welcome/onboarding flow instead of the login page. Returns only
 * non-secret bootstrap state: `{ initialized, allowRegistration, edition, ssoEnabled, setupCodeRequired, hubPublicUrl, authProviders, mailConfigured }`.
 * The one session-guarded route here is `GET version` (any signed-in member, not owner-only).
 */
@ApiTags("instance")
@Controller("instance")
export class InstanceController {
  constructor(
    private readonly instance: InstanceSettingsService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly update: UpdateService,
  ) {}

  /** Public white-label branding so the login page (and the whole app) can theme before/without auth. Only
   *  the non-secret brand fields, and only while the instance is Pro+ (else the Tugra defaults). */
  @Get("branding")
  branding() {
    return this.instance.effectiveBranding();
  }

  /**
   * Running version + whether a newer release is published, for EVERY signed-in member (session only). The
   * shell shows the version under the logo and an "update available" hint to non-owners, who cannot open
   * the owner-only Updates card. Deliberately not anonymous: a visitor must not learn that an instance is
   * behind (the public /version carries only the build itself). No preferences are exposed.
   */
  @Get("version")
  @UseGuards(JwtAuthGuard)
  @ApiZodResponse(MemberVersionViewSchema)
  version() {
    return this.update.getMemberVersion();
  }

  @Get("status")
  async status() {
    const s = await this.instance.get();
    // Same predicates the SSO services use (GithubOAuthService.isConfigured / OidcService.isConfigured).
    const oidc =
      editionAtLeast(currentEdition(), "pro") &&
      !!(s.oidcEnabled && s.oidcIssuer && s.oidcClientId && s.oidcClientSecretEnc);
    const github =
      !!this.config.get<string>("GITHUB_OAUTH_CLIENT_ID") && !!this.config.get<string>("GITHUB_OAUTH_CLIENT_SECRET");
    return {
      // First-user setup complete iff `initializedAt` has been claimed (see registration-gating).
      initialized: s.initializedAt != null,
      allowRegistration: s.allowRegistration,
      // Env-authoritative (single source of truth); the DB column is reserved for a future license writer.
      edition: currentEdition(),
      // Whether the login page should offer the SSO button: OIDC enabled + fully configured on a Pro+
      // edition. Non-secret (mirrors OidcService.isConfigured); the button just kicks off the redirect.
      ssoEnabled:
        editionAtLeast(currentEdition(), "pro") &&
        !!(s.oidcEnabled && s.oidcIssuer && s.oidcClientId && s.oidcClientSecretEnc),
      // Whether the welcome form must ask for the first-run setup code: a code is configured AND the
      // owner has not been claimed yet. Exposes ONLY the boolean — never the code itself.
      setupCodeRequired: !!this.config.get<string>("SETUP_CODE") && s.initializedAt == null,
      // Public origin of the hub (empty string when HUB_PUBLIC_URL is unset) — a URL, not a secret.
      hubPublicUrl: (this.config.get<string>("HUB_PUBLIC_URL") ?? "").replace(/\/$/, ""),
      // Which SSO providers are CONFIGURED (booleans only — never IDs or secrets).
      authProviders: { github, oidc },
      // Whether an outbound mailer (MAIL_HOST) is configured — a boolean only, never credentials. Lets the UI
      // stop implying that reset/verification email was sent when this hub cannot send any.
      mailConfigured: this.mail.isConfigured(),
    };
  }
}

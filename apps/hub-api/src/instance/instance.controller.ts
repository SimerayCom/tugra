import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { InstanceSettingsService } from "./instance-settings.service";
import { currentEdition, editionAtLeast } from "../common/edition";

/**
 * Public onboarding/instance status. No `@UseGuards` → unauthenticated by default (auth is opt-in per
 * controller here), like Health/Version. The web root reads this before any login to decide whether a
 * fresh instance should show the welcome/onboarding flow instead of the login page. Returns only
 * non-secret bootstrap state: `{ initialized, allowRegistration, edition, ssoEnabled, setupCodeRequired }`.
 */
@ApiTags("instance")
@Controller("instance")
export class InstanceController {
  constructor(
    private readonly instance: InstanceSettingsService,
    private readonly config: ConfigService,
  ) {}

  @Get("status")
  async status() {
    const s = await this.instance.get();
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
    };
  }
}

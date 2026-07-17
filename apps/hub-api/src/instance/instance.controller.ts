import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { InstanceSettingsService } from "./instance-settings.service";
import { currentEdition } from "../common/edition";

/**
 * Public onboarding/instance status. No `@UseGuards` → unauthenticated by default (auth is opt-in per
 * controller here), like Health/Version. The web root reads this before any login to decide whether a
 * fresh instance should show the welcome/onboarding flow instead of the login page. Returns only
 * non-secret bootstrap state: `{ initialized, allowRegistration, edition }`.
 */
@ApiTags("instance")
@Controller("instance")
export class InstanceController {
  constructor(private readonly instance: InstanceSettingsService) {}

  @Get("status")
  async status() {
    const s = await this.instance.get();
    return {
      // First-user setup complete iff `initializedAt` has been claimed (see registration-gating).
      initialized: s.initializedAt != null,
      allowRegistration: s.allowRegistration,
      // Env-authoritative (single source of truth); the DB column is reserved for a future license writer.
      edition: currentEdition(),
    };
  }
}

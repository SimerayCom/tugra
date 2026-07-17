import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { versionInfo } from "@tugra/shared";

/**
 * Public build/version descriptor. No `@UseGuards` → unauthenticated by default (auth is opt-in per
 * controller here), like HealthController. Returns only non-secret build metadata:
 * `{ version, protocol, channel, commit, edition }`.
 */
@ApiTags("version")
@Controller("version")
export class VersionController {
  @Get()
  version() {
    return versionInfo();
  }
}

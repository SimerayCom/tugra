import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ApiTags, ApiCookieAuth } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { AuditService } from "../audit/audit.service";
import { InstanceSettingsService } from "./instance-settings.service";
import { InstanceOwnerGuard } from "./instance-owner.guard";
import { currentEdition } from "../common/edition";
import { UpdateInstanceSettingsInput, UpdateInstanceSettingsSchema } from "./dto";

/**
 * Owner-only instance settings, managed with the login SESSION (JwtAuthGuard, not ApiAuthGuard) — like API
 * token management. Being session-only means a PAT can't reach it AND it isn't subject to the API gating it
 * configures, so an owner can never lock themselves out (the web always works to re-enable the API).
 */
@ApiTags("instance")
@ApiCookieAuth("session")
@Controller("instance")
@UseGuards(JwtAuthGuard, InstanceOwnerGuard)
export class InstanceSettingsController {
  constructor(
    private readonly settings: InstanceSettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get("settings")
  async getSettings() {
    const s = await this.settings.get();
    // `edition` is env/license-driven and read-only here (deliberately absent from PATCH) — surfacing it
    // lets the owner see their tier without being able to grant themselves a higher one.
    return { apiEnabled: s.apiEnabled, apiAllowedIps: s.apiAllowedIps, edition: currentEdition() };
  }

  @Patch("settings")
  @ApiZodBody(UpdateInstanceSettingsSchema)
  async updateSettings(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateInstanceSettingsSchema)) body: UpdateInstanceSettingsInput,
  ) {
    const patch: { apiEnabled?: boolean; apiAllowedIps?: string[] } = {};
    if (body.apiEnabled !== undefined) patch.apiEnabled = body.apiEnabled;
    if (body.apiAllowedIps !== undefined) {
      patch.apiAllowedIps = body.apiAllowedIps.map((e) => e.trim()).filter(Boolean);
    }
    const s = await this.settings.update(patch);
    await this.audit.log({ actor: user.userId, action: "instance_settings.update", target: "singleton" });
    return { apiEnabled: s.apiEnabled, apiAllowedIps: s.apiAllowedIps };
  }
}

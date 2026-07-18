import { Body, Controller, Get, HttpCode, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiCookieAuth } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { AuditService } from "../audit/audit.service";
import { InstanceSettingsService } from "./instance-settings.service";
import { InstanceOwnerGuard } from "./instance-owner.guard";
import { currentEdition } from "../common/edition";
import {
  UpdateInstanceSettingsInput,
  UpdateInstanceSettingsSchema,
  UpdateInstanceUpdateInput,
  UpdateInstanceUpdateSchema,
} from "./dto";
import { UpdateService } from "../update/update.service";
import { UpdateStatusViewSchema } from "../update/dto";

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
    private readonly update: UpdateService,
  ) {}

  /**
   * Self-update status: the running version, the latest published version for the tracked channel (from
   * the last signed check — cached, no remote fetch on this path), and whether an update is available.
   * `updateAvailable` is computed against the running build, so an older/stale manifest never suggests a
   * downgrade. Owner-only (inherits the class guards); nothing is applied here (the updater is a later slice).
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
   * apply step lives in a later slice.
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
}

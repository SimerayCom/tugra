import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiTags, ApiCookieAuth } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { InstanceOwnerGuard } from "../instance/instance-owner.guard";
import { HubBackupService } from "./hub-backup.service";
import { HubBackupConfigSchema, type HubBackupConfigInput } from "./dto";

/**
 * Owner-only control-plane DB backup, managed with the login SESSION (like instance settings). Free (no
 * edition guard). The dump spans every team, so it is never team-scoped — InstanceOwnerGuard gates it.
 */
@ApiTags("instance")
@ApiCookieAuth()
@Controller("instance/backup")
@UseGuards(JwtAuthGuard, InstanceOwnerGuard)
export class HubBackupController {
  constructor(private readonly hub: HubBackupService) {}

  @Get()
  get() {
    return this.hub.get();
  }

  @Put()
  @HttpCode(200)
  @ApiZodBody(HubBackupConfigSchema)
  update(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(HubBackupConfigSchema)) body: HubBackupConfigInput) {
    return this.hub.update(user.userId, body);
  }

  @Post("run")
  @HttpCode(200)
  run(@CurrentUser() user: AuthUser) {
    return this.hub.run(user.userId);
  }

  @Post("test")
  @HttpCode(200)
  async test() {
    const cfg = await this.hub.get();
    return this.hub.testDestination(cfg.destinationId);
  }

  @Get("items")
  items() {
    return this.hub.items();
  }

  @Delete("items/:id")
  @HttpCode(200)
  async deleteItem(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.hub.deleteItem(user.userId, id);
    return { ok: true };
  }
}

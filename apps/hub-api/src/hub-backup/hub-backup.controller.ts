import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiTags, ApiCookieAuth } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { InstanceOwnerGuard } from "../instance/instance-owner.guard";
import { z } from "zod";
import { HubBackupService } from "./hub-backup.service";
import { DestinationKeysExportService } from "./destination-keys-export.service";
import { HubRestoreDrillService } from "./hub-restore-drill.service";
import { HubDeadmanService } from "./hub-deadman.service";
import { DestinationKeysExportSchema, HubBackupConfigSchema, HubDeadmanSchema, type DestinationKeysExportInput, type HubBackupConfigInput, type HubDeadmanInput } from "./dto";

const SealedKeyExportSchema = z.object({
  filename: z.string(),
  format: z.string(),
  contentBase64: z.string(),
  destinationCount: z.number(),
  undecryptable: z.array(z.string()),
});

/**
 * Owner-only control-plane DB backup, managed with the login SESSION (like instance settings). Free (no
 * edition guard). The dump spans every team, so it is never team-scoped — InstanceOwnerGuard gates it.
 */
@ApiTags("instance")
@ApiCookieAuth()
@Controller("instance/backup")
@UseGuards(JwtAuthGuard, InstanceOwnerGuard)
export class HubBackupController {
  constructor(
    private readonly hub: HubBackupService,
    private readonly keysExport: DestinationKeysExportService,
    private readonly drills: HubRestoreDrillService,
    private readonly deadman: HubDeadmanService,
  ) {}

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

  /** Restore the newest hub backup into a throwaway container and check it (the monthly drill, on demand). */
  @Post("drill")
  @HttpCode(200)
  @Throttle({ default: { limit: 6, ttl: 3_600_000 } })
  runDrill(@CurrentUser() user: AuthUser) {
    return this.drills.run("manual", user.userId);
  }

  @Get("drills")
  listDrills() {
    return this.drills.list();
  }

  @Get("deadman")
  getDeadman() {
    return this.deadman.get();
  }

  @Put("deadman")
  @HttpCode(200)
  @ApiZodBody(HubDeadmanSchema)
  setDeadman(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(HubDeadmanSchema)) body: HubDeadmanInput) {
    return this.deadman.update(user.userId, body);
  }

  /** One immediate check-in to the saved address, so a wrong address shows at setup time. */
  @Post("deadman/test")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  testDeadman() {
    return this.deadman.test();
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

  // Owner-only sealed export of every encrypted destination's data key (+ the hub-backup passphrase). 5/hour;
  // the response is a secret, so it is never cached. Open with:
  //   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in tugra-destination-keys-<date>.enc
  @Post("destination-keys/export")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Header("Cache-Control", "no-store")
  @ApiZodBody(DestinationKeysExportSchema)
  @ApiZodResponse(SealedKeyExportSchema)
  exportKeys(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(DestinationKeysExportSchema)) body: DestinationKeysExportInput) {
    return this.keysExport.exportSealed(user.userId, body.passphrase);
  }
}

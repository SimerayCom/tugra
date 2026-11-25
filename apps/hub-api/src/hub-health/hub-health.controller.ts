import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { ApiZodResponse } from "../openapi/openapi";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { InstanceOwnerGuard } from "../instance/instance-owner.guard";
import { HubHealthService } from "./hub-health.service";
import { HubHealthSchema } from "./dto";

/** The hub's own health, for the instance owner only (session, like the other owner settings; a PAT cannot reach it). */
@ApiTags("instance")
@ApiCookieAuth("session")
@Controller("instance/hub-health")
@UseGuards(JwtAuthGuard, InstanceOwnerGuard)
export class HubHealthController {
  constructor(private readonly health: HubHealthService) {}

  @Get()
  @ApiZodResponse(HubHealthSchema)
  get() {
    return this.health.snapshot();
  }
}

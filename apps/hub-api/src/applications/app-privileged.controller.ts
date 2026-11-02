import { Body, Controller, HttpCode, Param, Put, UseGuards } from "@nestjs/common";
import { ApiTags, ApiCookieAuth } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { InstanceOwnerGuard } from "../instance/instance-owner.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ApplicationsService } from "./applications.service";
import { SetAllowPrivilegedDockerOptionsSchema, type SetAllowPrivilegedDockerOptionsInput } from "./dto";

/**
 * INSTANCE-OWNER-ONLY, session-based toggle for the per-app host-privilege gate
 * (Application.allowPrivilegedDockerOptions). It lives on its OWN controller — not ApplicationsController —
 * precisely because that controller is PAT-capable (ApiAuthGuard): granting host-root power must never be
 * reachable by a stolen or low-scope personal-access token. JwtAuthGuard = session cookie only; the owner is
 * verified from the DB by InstanceOwnerGuard and need not be a member of the app's team. The route path is
 * distinct from ApplicationsController's :id/docker-options, so the two controllers don't collide.
 */
@ApiTags("applications")
@ApiCookieAuth("session")
@Controller("apps")
@UseGuards(JwtAuthGuard, InstanceOwnerGuard)
export class AppPrivilegedController {
  constructor(private readonly apps: ApplicationsService) {}

  @Put(":id/allow-privileged-docker-options")
  @HttpCode(200)
  @ApiZodBody(SetAllowPrivilegedDockerOptionsSchema)
  async set(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetAllowPrivilegedDockerOptionsSchema)) body: SetAllowPrivilegedDockerOptionsInput,
  ) {
    await this.apps.setAllowPrivilegedDockerOptions(user.userId, id, body.allow);
    return { ok: true };
  }
}

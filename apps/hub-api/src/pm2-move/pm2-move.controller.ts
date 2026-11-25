import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { InstanceOwnerGuard } from "../instance/instance-owner.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { Pm2MoveService } from "./pm2-move.service";
import { Pm2MoveSchema, Pm2PlanSchema, type Pm2MoveInput, type Pm2PlanInput } from "./dto";

/**
 * "Move to Tugra (in place)" for PM2 processes. INSTANCE-OWNER-ONLY and SESSION-ONLY (never a personal-access token),
 * for the same reason as the per-app host-privilege toggle: the container it creates runs on the host network, binds a
 * host directory read-write and runs as the process's own uid, and the app record carries the owner override for it.
 */
@ApiTags("servers")
@ApiCookieAuth("session")
@Controller("servers/:id/pm2-move")
@UseGuards(JwtAuthGuard, InstanceOwnerGuard)
export class Pm2MoveController {
  constructor(private readonly moves: Pm2MoveService) {}

  /** Read-only preview: one plan per PM2 process (what would happen, or why it cannot). */
  @Post("plan")
  @HttpCode(200)
  @ApiZodBody(Pm2PlanSchema)
  plan(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(Pm2PlanSchema)) body: Pm2PlanInput) {
    return this.moves.plan(user.userId, id, body);
  }

  /** Start moving the confirmed processes, one after the other. Returns the job to poll. */
  @Post()
  @HttpCode(202)
  @ApiZodBody(Pm2MoveSchema)
  start(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(Pm2MoveSchema)) body: Pm2MoveInput) {
    return this.moves.start(user.userId, id, body);
  }

  @Get(":jobId")
  job(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("jobId") jobId: string) {
    return this.moves.getJob(user.userId, id, jobId);
  }
}

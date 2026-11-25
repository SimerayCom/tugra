import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody } from "../openapi/openapi";
import { CoolifySshInstallService } from "./coolify-ssh-install.service";
import { SshConfirmSchema, SshStartSchema, type SshConfirmInput, type SshStartInput } from "./dto";

/**
 * Install the Tugra agent on the servers a Coolify knows, over Coolify's own SSH keys, through the agent on the Coolify host (the keys never
 * leave that host). Team OWNER only for every step that acts; ADMIN may read progress. Acting needs `write` and `read:secrets` and the typed
 * number of servers in `confirm`. Nothing here returns a token, a key or a command line.
 */
@ApiTags("coolify-takeover")
@ApiSecurity("pat")
@Controller("coolify-takeover/servers/:serverId/ssh")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class CoolifySshController {
  constructor(private readonly ssh: CoolifySshInstallService) {}

  /** The newest install run of this Coolify host (null when there is none). */
  @Get("runs/latest")
  latest(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string) {
    return this.ssh.latestRun(user.userId, serverId);
  }

  @Get("runs/:runId")
  get(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string, @Param("runId") runId: string) {
    return this.ssh.getRun(user.userId, serverId, runId);
  }

  /** Consent for N servers and a read-only probe of them. Nothing is installed. */
  @Post("runs")
  @HttpCode(200)
  @RequireScopes("write", "read:secrets")
  @ApiZodBody(SshStartSchema)
  start(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string, @Body(new ZodValidationPipe(SshStartSchema)) body: SshStartInput) {
    return this.ssh.startRun(user.userId, serverId, body);
  }

  /** Install the agent on the servers of the run that the probe found ready. */
  @Post("runs/:runId/install")
  @HttpCode(200)
  @RequireScopes("write", "read:secrets")
  @ApiZodBody(SshConfirmSchema)
  install(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string, @Param("runId") runId: string, @Body(new ZodValidationPipe(SshConfirmSchema)) body: SshConfirmInput) {
    return this.ssh.startInstall(user.userId, serverId, runId, body);
  }

  /** Take the agent off the servers this run installed it on. */
  @Post("runs/:runId/uninstall")
  @HttpCode(200)
  @RequireScopes("write", "read:secrets")
  @ApiZodBody(SshConfirmSchema)
  uninstall(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string, @Param("runId") runId: string, @Body(new ZodValidationPipe(SshConfirmSchema)) body: SshConfirmInput) {
    return this.ssh.startUninstall(user.userId, serverId, runId, body);
  }

  /** Stop the run, end the consent. An agent that was installed in the middle is removed again. */
  @Post("runs/:runId/cancel")
  @HttpCode(200)
  @RequireScopes("write")
  cancel(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string, @Param("runId") runId: string) {
    return this.ssh.cancelRun(user.userId, serverId, runId);
  }
}

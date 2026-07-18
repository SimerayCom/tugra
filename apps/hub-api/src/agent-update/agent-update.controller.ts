import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { AgentUpdateService } from "./agent-update.service";

const FleetSchema = z.object({ serverIds: z.array(z.string()).min(1) });
type FleetInput = z.infer<typeof FleetSchema>;

const AgentUpdateItemSchema = z.object({
  serverId: z.string(),
  status: z.enum(["sent", "offline", "skipped"]),
  reason: z.string().optional(),
});
const AgentUpdateResponseSchema = z.object({
  status: z.enum(["ok", "unconfigured", "error"]),
  total: z.number(),
  sent: z.number(),
  offline: z.number(),
  skipped: z.number(),
  results: z.array(AgentUpdateItemSchema),
});

// Triggers a signed, digest-pinned self-update of the Go agent(s). The target version + image + sha256
// come ONLY from the hub's ed25519-verified release manifest — never the request — so a caller can never
// make the hub sign an arbitrary image. `deploy` scope + the team's `servers:manage` permission required.
@ApiTags("agent-update")
@ApiSecurity("pat")
@Controller()
@UseGuards(ApiAuthGuard, ScopesGuard)
export class AgentUpdateController {
  constructor(private readonly agentUpdate: AgentUpdateService) {}

  @Post("servers/:id/agent-update")
  @RequireScopes("deploy")
  @ApiZodResponse(AgentUpdateResponseSchema)
  updateOne(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.agentUpdate.updateOne(user.userId, id);
  }

  @Post("fleet/agent-update")
  @RequireScopes("deploy")
  @ApiZodBody(FleetSchema)
  @ApiZodResponse(AgentUpdateResponseSchema)
  updateFleet(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(FleetSchema)) body: FleetInput) {
    return this.agentUpdate.updateFleet(user.userId, body.serverIds);
  }
}

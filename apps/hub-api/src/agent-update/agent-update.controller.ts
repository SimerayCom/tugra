import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
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
import { InFlightItemSchema } from "../in-flight/in-flight.dto";

// `force` updates a server even while work is in flight on it (owner or admin of the team only; audited).
const FleetSchema = z.object({ serverIds: z.array(z.string()).min(1), force: z.boolean().optional() });
type FleetInput = z.infer<typeof FleetSchema>;
const ForceSchema = z.object({ force: z.boolean().optional() });
type ForceInput = z.infer<typeof ForceSchema>;

const AgentUpdateItemSchema = z.object({
  serverId: z.string(),
  status: z.enum(["sent", "offline", "skipped", "held"]),
  reason: z.string().optional(),
  inFlight: z.array(InFlightItemSchema).optional(),
});
const AgentUpdateResponseSchema = z.object({
  status: z.enum(["ok", "unconfigured", "error", "hub-behind"]),
  total: z.number(),
  sent: z.number(),
  offline: z.number(),
  skipped: z.number(),
  held: z.number(),
  results: z.array(AgentUpdateItemSchema),
});

const AgentFleetStatusSchema = z.object({
  current: z.string(), // the hub's own release: what every agent should be on
  total: z.number(), // remote servers with an enrolled agent, in teams the caller manages
  outdated: z.number(),
  outdatedServerIds: z.array(z.string()),
  autoUpdate: z.boolean(), // "Apply updates automatically" is on: the hub rolls agents out by itself
  held: z.array(z.object({ serverId: z.string(), inFlight: z.array(InFlightItemSchema) })), // servers with work in flight: no update starts on them
  hubBehind: z.boolean(),
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

  // 409 `migration-active` (with `inFlight`) while a migration, takeover, cutover, move or transfer is running on the server;
  // `force: true` goes ahead for an owner or admin of the team and is audited.
  @Post("servers/:id/agent-update")
  @RequireScopes("deploy")
  @ApiZodBody(ForceSchema, { required: false })
  @ApiZodResponse(AgentUpdateResponseSchema)
  updateOne(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(ForceSchema)) body: ForceInput) {
    return this.agentUpdate.updateOne(user.userId, id, body.force === true);
  }

  // "3/24 agents are on an older version": counts only the remote agents of teams the caller manages (servers:manage),
  // never another team's. Pure read of the DB + the running version (no manifest fetch).
  @Get("fleet/agent-update/status")
  @RequireScopes("read")
  @ApiZodResponse(AgentFleetStatusSchema)
  status(@CurrentUser() user: AuthUser) {
    return this.agentUpdate.fleetStatus(user.userId);
  }

  // One click: update every outdated agent the caller manages to the hub's release.
  @Post("fleet/agent-update/outdated")
  @RequireScopes("deploy")
  @ApiZodBody(ForceSchema, { required: false })
  @ApiZodResponse(AgentUpdateResponseSchema)
  updateOutdated(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(ForceSchema)) body: ForceInput) {
    return this.agentUpdate.updateOutdated(user.userId, body.force === true);
  }

  @Post("fleet/agent-update")
  @RequireScopes("deploy")
  @ApiZodBody(FleetSchema)
  @ApiZodResponse(AgentUpdateResponseSchema)
  updateFleet(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(FleetSchema)) body: FleetInput) {
    return this.agentUpdate.updateFleet(user.userId, body.serverIds, body.force === true);
  }
}

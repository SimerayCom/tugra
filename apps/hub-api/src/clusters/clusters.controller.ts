import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ClustersService } from "./clusters.service";
import { SwarmService } from "./swarm.service";
import {
  AddManagerInput,
  AddManagerSchema,
  CreateClusterInput,
  CreateClusterSchema,
  FormSwarmInput,
  FormSwarmSchema,
  JoinNodeInput,
  JoinNodeSchema,
  SetNodeLabelsInput,
  SetNodeLabelsSchema,
  SetServersInput,
  SetServersSchema,
  UpdateClusterInput,
  UpdateClusterSchema,
} from "./dto";

/** Team-scoped server groups (clusters). Reads are team-membership-scoped; mutations require the
 *  servers:manage permission (enforced in the service). Group-scoped bulk ops go through /bulk with the
 *  cluster's member ids (client-side), reusing the existing permission-filtered fan-out. */
@ApiTags("clusters")
@ApiSecurity("pat")
@Controller("clusters")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ClustersController {
  constructor(
    private readonly clusters: ClustersService,
    private readonly swarm: SwarmService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query("teamId") teamId?: string) {
    return this.clusters.list(user.userId, teamId);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.clusters.get(user.userId, id);
  }

  @Post()
  @ApiZodBody(CreateClusterSchema)
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateClusterSchema)) body: CreateClusterInput) {
    return this.clusters.create(user.userId, body);
  }

  @Patch(":id")
  @ApiZodBody(UpdateClusterSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateClusterSchema)) body: UpdateClusterInput,
  ) {
    return this.clusters.update(user.userId, id, body);
  }

  // No @RequireScopes → inherits the platform default (DELETE ⇒ "admin"), like every other destructive
  // delete route. The service also enforces the servers:manage team permission.
  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<void> {
    await this.clusters.remove(user.userId, id);
  }

  @Put(":id/servers")
  @ApiZodBody(SetServersSchema)
  setServers(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetServersSchema)) body: SetServersInput,
  ) {
    return this.clusters.setServers(user.userId, id, body);
  }

  // ── Docker Swarm formation (Phase2) ──

  // Forming a swarm dispatches signed `docker swarm` commands to N agents — same shape as /bulk,
  // scheduled-tasks, tunnel setup — so it requires the elevated "deploy" scope (above the plain-write
  // default of a metadata PUT). The service also enforces the servers:manage team permission.
  @Post(":id/swarm")
  @RequireScopes("deploy")
  @ApiZodBody(FormSwarmSchema)
  formSwarm(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(FormSwarmSchema)) body: FormSwarmInput,
  ) {
    return this.swarm.form(user.userId, id, body);
  }

  // Add one more node to an already-ACTIVE swarm. Same elevated scope as Form Swarm (it too dispatches a
  // signed `docker swarm` command to an agent); the service enforces servers:manage.
  @Post(":id/swarm/nodes")
  @RequireScopes("deploy")
  @ApiZodBody(JoinNodeSchema)
  joinSwarmNode(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(JoinNodeSchema)) body: JoinNodeInput,
  ) {
    return this.swarm.joinNode(user.userId, id, body);
  }

  @Get(":id/swarm")
  swarmStatus(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.swarm.status(user.userId, id);
  }

  // No @RequireScopes → inherits the platform default (DELETE ⇒ "admin"), like the cluster delete above.
  // Dissolve is destructive; annotating would only ever LOWER that scope.
  @Delete(":id/swarm")
  dissolveSwarm(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.swarm.dissolve(user.userId, id);
  }

  // Remove ONE node from a live swarm (drain → leave → rm), without dissolving the rest. No @RequireScopes →
  // inherits the platform DELETE⇒admin default, same rationale as dissolveSwarm (dispatches signed docker
  // commands to mutate a live swarm). The service enforces servers:manage.
  @Delete(":id/swarm/nodes/:serverId")
  leaveSwarmNode(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("serverId") serverId: string) {
    return this.swarm.leaveNode(user.userId, id, serverId);
  }

  // Add/remove docker node labels (feeds the placement picker). deploy scope + servers:manage, same tier as
  // Form Swarm — it dispatches a signed `docker node update` to the manager. nodeId is the docker swarm node id.
  @Put(":id/swarm/nodes/:nodeId/labels")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(SetNodeLabelsSchema)
  setNodeLabels(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("nodeId") nodeId: string,
    @Body(new ZodValidationPipe(SetNodeLabelsSchema)) body: SetNodeLabelsInput,
  ) {
    return this.swarm.setNodeLabels(user.userId, id, nodeId, body);
  }

  // Add one more MANAGER (FLEET-G, multi-manager Raft HA): promote an existing worker or have a fresh member
  // join directly as a manager. Same elevated scope as Form Swarm — it dispatches signed `docker node promote`/
  // `docker swarm join` to agents; the service enforces servers:manage.
  @Post(":id/swarm/managers")
  @RequireScopes("deploy")
  @ApiZodBody(AddManagerSchema)
  addManager(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(AddManagerSchema)) body: AddManagerInput,
  ) {
    return this.swarm.addManager(user.userId, id, body);
  }

  // Demote a MANAGER back to a worker (FLEET-G). No @RequireScopes → inherits the platform DELETE⇒admin
  // default, same rationale as dissolveSwarm: annotating would only ever LOWER that scope for a destructive op.
  @Delete(":id/swarm/managers/:serverId")
  removeManager(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("serverId") serverId: string,
    @Query("acknowledgeEvenQuorum") acknowledgeEvenQuorum?: string,
  ) {
    return this.swarm.removeManager(user.userId, id, { serverId, acknowledgeEvenQuorum: acknowledgeEvenQuorum === "true" });
  }
}

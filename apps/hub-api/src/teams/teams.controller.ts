import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { TeamsService } from "./teams.service";
import {
  CreateTeamInput,
  CreateTeamSchema,
  InviteInput,
  InviteSchema,
  RenameTeamInput,
  RenameTeamSchema,
  SetMemberAccessInput,
  SetMemberAccessSchema,
  SetRoleInput,
  SetRoleSchema,
  TeamRoleInput,
  TeamRoleSchema,
  UpdateTeamRoleInput,
  UpdateTeamRoleSchema,
} from "./dto";

@Controller("teams")
@UseGuards(JwtAuthGuard)
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.teams.list(user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateTeamSchema)) body: CreateTeamInput,
  ) {
    return this.teams.create(user.userId, body.name);
  }

  // Static segments before ":id" so they aren't matched as a team id.
  @Get("invitations/mine")
  myInvitations(@CurrentUser() user: AuthUser) {
    return this.teams.myInvitations(user.userId);
  }

  @Post("invitations/:token/accept")
  @HttpCode(200)
  async accept(@CurrentUser() user: AuthUser, @Param("token") token: string) {
    await this.teams.acceptInvitation(user.userId, token);
    return { ok: true };
  }

  @Post("invitations/:token/decline")
  @HttpCode(200)
  async decline(@CurrentUser() user: AuthUser, @Param("token") token: string) {
    await this.teams.declineInvitation(user.userId, token);
    return { ok: true };
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.teams.get(user.userId, id);
  }

  @Put(":id")
  @HttpCode(200)
  async rename(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RenameTeamSchema)) body: RenameTeamInput,
  ) {
    await this.teams.rename(user.userId, id, body.name);
    return { ok: true };
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.teams.remove(user.userId, id);
    return { ok: true };
  }

  @Get(":id/members")
  members(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.teams.members(user.userId, id);
  }

  @Post(":id/members/invite")
  invite(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(InviteSchema)) body: InviteInput,
  ) {
    return this.teams.invite(user.userId, id, body.email, body.role as Role);
  }

  @Get(":id/invitations")
  invitations(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.teams.teamInvitations(user.userId, id);
  }

  @Delete(":id/invitations/:invId")
  @HttpCode(200)
  async revoke(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("invId") invId: string) {
    await this.teams.revokeInvitation(user.userId, id, invId);
    return { ok: true };
  }

  @Put(":id/members/:userId")
  @HttpCode(200)
  async setRole(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("userId") targetUserId: string,
    @Body(new ZodValidationPipe(SetRoleSchema)) body: SetRoleInput,
  ) {
    await this.teams.setRole(user.userId, id, targetUserId, { role: body.role as Role | undefined, teamRoleId: body.teamRoleId });
    return { ok: true };
  }

  // ---- custom roles ----
  @Get(":id/roles")
  listRoles(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.teams.listRoles(user.userId, id);
  }

  @Post(":id/roles")
  createRole(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(TeamRoleSchema)) body: TeamRoleInput,
  ) {
    return this.teams.createRole(user.userId, id, body);
  }

  @Put(":id/roles/:roleId")
  updateRole(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("roleId") roleId: string,
    @Body(new ZodValidationPipe(UpdateTeamRoleSchema)) body: UpdateTeamRoleInput,
  ) {
    return this.teams.updateRole(user.userId, id, roleId, body);
  }

  @Delete(":id/roles/:roleId")
  @HttpCode(200)
  async deleteRole(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("roleId") roleId: string) {
    await this.teams.deleteRole(user.userId, id, roleId);
    return { ok: true };
  }

  @Patch(":id/members/:userId/access")
  @HttpCode(200)
  async setMemberAccess(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("userId") targetUserId: string,
    @Body(new ZodValidationPipe(SetMemberAccessSchema)) body: SetMemberAccessInput,
  ) {
    await this.teams.setMemberAccess(user.userId, id, targetUserId, body);
    return { ok: true };
  }

  @Delete(":id/members/:userId")
  @HttpCode(200)
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("userId") targetUserId: string,
  ) {
    await this.teams.removeMember(user.userId, id, targetUserId);
    return { ok: true };
  }
}

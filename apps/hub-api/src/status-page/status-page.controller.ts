import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody } from "../openapi/openapi";
import { StatusPageService } from "./status-page.service";
import { CreateMaintenanceInput, CreateMaintenanceSchema, UpdateStatusPageInput, UpdateStatusPageSchema } from "./dto";

/** A team's public status page settings. Reads need team membership; every change needs the `monitors` permission. */
@ApiTags("status-page")
@ApiSecurity("pat")
@Controller("teams/:teamId/status-page")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class StatusPageController {
  constructor(private readonly pages: StatusPageService) {}

  @Get()
  get(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string) {
    return this.pages.get(user.userId, teamId);
  }

  @Put()
  @HttpCode(200)
  @ApiZodBody(UpdateStatusPageSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("teamId") teamId: string,
    @Body(new ZodValidationPipe(UpdateStatusPageSchema)) body: UpdateStatusPageInput,
  ) {
    return this.pages.update(user.userId, teamId, body);
  }

  @Delete()
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string) {
    await this.pages.remove(user.userId, teamId);
    return { ok: true };
  }

  @Post("maintenance")
  @HttpCode(200)
  @ApiZodBody(CreateMaintenanceSchema)
  addMaintenance(
    @CurrentUser() user: AuthUser,
    @Param("teamId") teamId: string,
    @Body(new ZodValidationPipe(CreateMaintenanceSchema)) body: CreateMaintenanceInput,
  ) {
    return this.pages.addMaintenance(user.userId, teamId, body);
  }

  @Delete("maintenance/:id")
  @HttpCode(200)
  removeMaintenance(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string, @Param("id") id: string) {
    return this.pages.removeMaintenance(user.userId, teamId, id);
  }
}

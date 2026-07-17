import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ScheduledTasksService, TaskViewSchema } from "./scheduled-tasks.service";
import { CreateTaskInput, CreateTaskSchema, UpdateTaskInput, UpdateTaskSchema } from "./dto";

@ApiTags("scheduled-tasks")
@ApiSecurity("pat")
@Controller("apps")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ScheduledTasksController {
  constructor(private readonly tasks: ScheduledTasksService) {}

  @Get(":id/tasks")
  @ApiZodResponse(TaskViewSchema, { isArray: true })
  list(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.tasks.list(user.userId, id);
  }

  @Post(":id/tasks")
  @RequireScopes("deploy") // the task body runs `docker exec sh -c <command>` — arbitrary in-container execution
  @HttpCode(201)
  @ApiZodBody(CreateTaskSchema)
  @ApiZodResponse(TaskViewSchema, { status: 201 })
  create(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CreateTaskSchema)) body: CreateTaskInput,
  ) {
    return this.tasks.create(user.userId, id, body);
  }

  @Put(":id/tasks/:taskId")
  @RequireScopes("deploy") // updates the arbitrary `docker exec` command — same execution surface as create
  @HttpCode(200)
  @ApiZodBody(UpdateTaskSchema)
  @ApiZodResponse(TaskViewSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("taskId") taskId: string,
    @Body(new ZodValidationPipe(UpdateTaskSchema)) body: UpdateTaskInput,
  ) {
    return this.tasks.update(user.userId, id, taskId, body);
  }

  @Delete(":id/tasks/:taskId")
  @HttpCode(200)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("taskId") taskId: string,
  ) {
    await this.tasks.remove(user.userId, id, taskId);
    return { ok: true };
  }
}

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
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ScheduledTasksService } from "./scheduled-tasks.service";
import { CreateTaskInput, CreateTaskSchema, UpdateTaskInput, UpdateTaskSchema } from "./dto";

@Controller("apps")
@UseGuards(ApiAuthGuard)
export class ScheduledTasksController {
  constructor(private readonly tasks: ScheduledTasksService) {}

  @Get(":id/tasks")
  list(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.tasks.list(user.userId, id);
  }

  @Post(":id/tasks")
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CreateTaskSchema)) body: CreateTaskInput,
  ) {
    return this.tasks.create(user.userId, id, body);
  }

  @Put(":id/tasks/:taskId")
  @HttpCode(200)
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

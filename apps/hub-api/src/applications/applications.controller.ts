import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApplicationsService } from "./applications.service";
import { CreateAppInput, CreateAppSchema } from "./dto";

@Controller("apps")
@UseGuards(JwtAuthGuard)
export class ApplicationsController {
  constructor(private readonly apps: ApplicationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.apps.list(user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateAppSchema)) body: CreateAppInput,
  ) {
    return this.apps.create(user.userId, body);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.get(user.userId, id);
  }

  @Get(":id/deployments")
  deployments(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.deployments(user.userId, id);
  }

  @Post(":id/deploy")
  @HttpCode(200)
  deploy(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.deploy(user.userId, id);
  }

  @Post(":id/webhook/regenerate")
  @HttpCode(200)
  regenerateWebhook(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.apps.regenerateWebhook(user.userId, id);
  }

  @Post(":id/stop")
  @HttpCode(200)
  async stop(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.apps.stop(user.userId, id);
    return { ok: true };
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.apps.remove(user.userId, id);
    return { ok: true };
  }
}

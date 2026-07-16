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
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { DestinationsService } from "./destinations.service";
import { CreateDestinationInput, CreateDestinationSchema } from "./dto";

@Controller("backup-destinations")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class DestinationsController {
  constructor(private readonly destinations: DestinationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.destinations.list(user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateDestinationSchema)) body: CreateDestinationInput,
  ) {
    return this.destinations.create(user.userId, body);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.destinations.get(user.userId, id);
  }

  @Post(":id/test")
  @HttpCode(200)
  test(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.destinations.testConnection(user.userId, id);
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.destinations.remove(user.userId, id);
    return { ok: true };
  }
}

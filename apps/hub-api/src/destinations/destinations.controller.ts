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
import { DestinationsService } from "./destinations.service";
import { CreateDestinationInput, CreateDestinationSchema } from "./dto";

@Controller("backup-destinations")
@UseGuards(JwtAuthGuard)
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

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.destinations.remove(user.userId, id);
    return { ok: true };
  }
}

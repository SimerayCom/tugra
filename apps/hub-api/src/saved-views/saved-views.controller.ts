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
import { ApiTags, ApiCookieAuth } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { SavedViewsService } from "./saved-views.service";
import { CreateSavedViewInput, CreateSavedViewSchema } from "./dto";

@ApiTags("saved-views")
@ApiCookieAuth("session")
@Controller("saved-views")
@UseGuards(JwtAuthGuard) // personal UI preference, managed with your login session
export class SavedViewsController {
  constructor(private readonly views: SavedViewsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.views.list(user.userId);
  }

  @Post()
  @ApiZodBody(CreateSavedViewSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateSavedViewSchema)) body: CreateSavedViewInput,
  ) {
    return this.views.create(user.userId, body);
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.views.remove(user.userId, id);
    return { ok: true };
  }
}

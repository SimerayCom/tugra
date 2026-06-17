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
import { ApiTokensService } from "./api-tokens.service";
import { CreateApiTokenInput, CreateApiTokenSchema } from "./dto";

@Controller("api-tokens")
@UseGuards(JwtAuthGuard) // managed with your login session, not with a token
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.tokens.list(user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateApiTokenSchema)) body: CreateApiTokenInput,
  ) {
    return this.tokens.create(user.userId, body);
  }

  @Delete(":id")
  @HttpCode(200)
  async revoke(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.tokens.revoke(user.userId, id);
    return { ok: true };
  }
}

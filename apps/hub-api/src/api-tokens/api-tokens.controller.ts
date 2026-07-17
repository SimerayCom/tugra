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
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ApiTokensService, ApiTokenViewSchema, CreateApiTokenResultSchema } from "./api-tokens.service";
import { CreateApiTokenInput, CreateApiTokenSchema } from "./dto";

@ApiTags("api-tokens")
@ApiCookieAuth("session")
@Controller("api-tokens")
@UseGuards(JwtAuthGuard) // managed with your login session, not with a token
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @Get()
  @ApiZodResponse(ApiTokenViewSchema, { isArray: true })
  list(@CurrentUser() user: AuthUser) {
    return this.tokens.list(user.userId);
  }

  @Post()
  @ApiZodBody(CreateApiTokenSchema)
  @ApiZodResponse(CreateApiTokenResultSchema, { status: 201 })
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

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RedactSecretsInterceptor } from "../api-tokens/redact-secrets.interceptor";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { SharedVariablesService } from "./shared-variables.service";
import { SetSharedVarInput, SetSharedVarSchema } from "./dto";

@Controller("shared-variables")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class SharedVariablesController {
  constructor(private readonly vars: SharedVariablesService) {}

  @Get()
  @UseInterceptors(new RedactSecretsInterceptor(["value"]))
  list(@CurrentUser() user: AuthUser, @Query("teamId") teamId: string) {
    return this.vars.list(user.userId, teamId);
  }

  @Post()
  upsert(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(SetSharedVarSchema)) body: SetSharedVarInput,
  ) {
    return this.vars.upsert(user.userId, body.teamId, body.key, body.value);
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.vars.remove(user.userId, id);
    return { ok: true };
  }
}

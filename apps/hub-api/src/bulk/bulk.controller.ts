import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody } from "../openapi/openapi";
import { BulkService } from "./bulk.service";

const RunSchema = z.object({
  serverIds: z.array(z.string()).min(1),
  command: z.string().min(1),
});
type RunInput = z.infer<typeof RunSchema>;

@ApiTags("bulk")
@ApiSecurity("pat")
@Controller("bulk")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class BulkController {
  constructor(private readonly bulk: BulkService) {}

  @Post()
  @RequireScopes("deploy")
  @ApiZodBody(RunSchema)
  run(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(RunSchema)) body: RunInput,
  ) {
    return this.bulk.run(user.userId, body.serverIds, body.command);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.bulk.get(user.userId, id);
  }
}

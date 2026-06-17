import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CleanupService } from "./cleanup.service";
import { CleanupConfigInput, CleanupConfigSchema } from "./dto";

@Controller("servers/:id")
@UseGuards(JwtAuthGuard)
export class ServerOpsController {
  constructor(private readonly cleanup: CleanupService) {}

  @Post("cleanup")
  @HttpCode(200)
  cleanupNow(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.cleanup.cleanupNow(user.userId, id);
  }

  @Put("cleanup-config")
  @HttpCode(200)
  async setConfig(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CleanupConfigSchema)) body: CleanupConfigInput,
  ) {
    await this.cleanup.setConfig(user.userId, id, body);
    return { ok: true };
  }
}

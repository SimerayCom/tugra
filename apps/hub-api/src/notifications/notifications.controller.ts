import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { NotificationsService } from "./notifications.service";
import { CreateChannelInput, CreateChannelSchema, EVENT_TYPES, UpdateChannelInput, UpdateChannelSchema } from "./dto";

@ApiTags("channels")
@ApiSecurity("pat")
@Controller("channels")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query("q") q?: string) {
    return this.svc.list(user.userId, q);
  }

  /** The canonical, subscribable notification event ids — the single source the web UI renders from
   *  (so its event list never drifts from the backend enum). */
  @Get("events")
  events() {
    return { events: EVENT_TYPES };
  }

  @Post()
  @ApiZodBody(CreateChannelSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateChannelSchema)) body: CreateChannelInput,
  ) {
    return this.svc.create(user.userId, body);
  }

  @Put(":id")
  @HttpCode(200)
  @ApiZodBody(UpdateChannelSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateChannelSchema)) body: UpdateChannelInput,
  ) {
    return this.svc.update(user.userId, id, body);
  }

  @Post(":id/test")
  @HttpCode(200)
  async test(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.svc.test(user.userId, id);
    return { ok: true };
  }

  @Get(":id/deliveries")
  deliveries(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.listDeliveries(user.userId, id);
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.svc.remove(user.userId, id);
    return { ok: true };
  }
}

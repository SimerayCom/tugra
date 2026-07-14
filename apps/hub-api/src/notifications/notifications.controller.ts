import {
  Body,
  Controller,
  Delete,
  Get,
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
import { NotificationsService } from "./notifications.service";
import { CreateChannelInput, CreateChannelSchema, EVENT_TYPES, UpdateChannelInput, UpdateChannelSchema } from "./dto";

@Controller("channels")
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user.userId);
  }

  /** The canonical, subscribable notification event ids — the single source the web UI renders from
   *  (so its event list never drifts from the backend enum). */
  @Get("events")
  events() {
    return { events: EVENT_TYPES };
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateChannelSchema)) body: CreateChannelInput,
  ) {
    return this.svc.create(user.userId, body);
  }

  @Put(":id")
  @HttpCode(200)
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

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.svc.remove(user.userId, id);
    return { ok: true };
  }
}

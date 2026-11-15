import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiSecurity, ApiQuery } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { Paginated } from "../common/pagination.decorator";
import {
  CreateDestinationResponseSchema,
  DestinationsService,
  DestinationTestResultSchema,
  DestinationViewSchema,
} from "./destinations.service";
import {
  CreateDestinationInput,
  CreateDestinationSchema,
  DeleteDestinationQuerySchema,
  UpdateDestinationInput,
  UpdateDestinationSchema,
} from "./dto";

@ApiTags("backup-destinations")
@ApiSecurity("pat")
@Controller("backup-destinations")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class DestinationsController {
  constructor(private readonly destinations: DestinationsService) {}

  @Get()
  @ApiZodResponse(DestinationViewSchema, { isArray: true })
  @Paginated()
  list(@CurrentUser() user: AuthUser, @Query("q") q?: string) {
    return this.destinations.list(user.userId, q);
  }

  @Post()
  @ApiZodBody(CreateDestinationSchema)
  @ApiZodResponse(CreateDestinationResponseSchema, { status: 201 })
  // The response carries the one-time plaintext recoveryKey: never let a proxy or browser cache it.
  @Header("Cache-Control", "no-store")
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateDestinationSchema)) body: CreateDestinationInput,
  ) {
    return this.destinations.create(user.userId, body);
  }

  @Get(":id")
  @ApiZodResponse(DestinationViewSchema)
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.destinations.get(user.userId, id);
  }

  @Put(":id")
  @ApiZodBody(UpdateDestinationSchema)
  @ApiZodResponse(DestinationViewSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateDestinationSchema)) body: UpdateDestinationInput,
  ) {
    return this.destinations.update(user.userId, id, body);
  }

  @Post(":id/test")
  @HttpCode(200)
  @ApiZodResponse(DestinationTestResultSchema)
  test(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.destinations.testConnection(user.userId, id);
  }

  @Delete(":id")
  @HttpCode(200)
  @ApiQuery({ name: "discardBackups", required: false, type: Boolean, description: "confirm deleting an encrypted destination that still has backups" })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(DeleteDestinationQuerySchema)) query: z.infer<typeof DeleteDestinationQuerySchema>,
  ) {
    await this.destinations.remove(user.userId, id, { discardBackups: query.discardBackups });
    return { ok: true };
  }
}

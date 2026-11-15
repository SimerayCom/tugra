import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ObjectMigrationsService } from "./object-migrations.service";
import {
  CreateObjectMigrationSchema,
  ListObjectMigrationsQuerySchema,
  SetBucketsSchema,
  StartObjectMigrationSchema,
  type CreateObjectMigrationInput,
  type SetBucketsInput,
  type StartObjectMigrationInput,
} from "./dto";

/**
 * S3 / MinIO object migration (mc mirror run by the TARGET server's agent). Team-scoped in the service: mutations need
 * apps:config on the team that owns the target server; reads need membership. No response ever carries a credential.
 */
@ApiTags("object-migrations")
@ApiSecurity("pat")
@Controller("object-migrations")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ObjectMigrationsController {
  constructor(private readonly svc: ObjectMigrationsService) {}

  @Post()
  @RequireScopes("write")
  @ApiZodBody(CreateObjectMigrationSchema)
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateObjectMigrationSchema)) body: CreateObjectMigrationInput) {
    return this.svc.create(user.userId, body);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    const q = ListObjectMigrationsQuerySchema.safeParse({ teamId: query?.teamId });
    return this.svc.list(user.userId, q.success ? q.data.teamId : undefined);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.get(user.userId, id);
  }

  /** Probe both S3 sides + the agent's mc, list and size every bucket. Writes only the migration's own rows. */
  @Post(":id/preflight")
  @HttpCode(200)
  @RequireScopes("write")
  preflight(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.preflight(user.userId, id);
  }

  @Put(":id/buckets")
  @RequireScopes("write")
  @ApiZodBody(SetBucketsSchema)
  setBuckets(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(SetBucketsSchema)) body: SetBucketsInput) {
    return this.svc.setBuckets(user.userId, id, body);
  }

  /** Seed (live, copies missing keys only) or final (needs the frozen-writes acknowledgement; optional --remove). */
  @Post(":id/start")
  @HttpCode(202)
  @RequireScopes("write")
  @ApiZodBody(StartObjectMigrationSchema)
  start(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(StartObjectMigrationSchema)) body: StartObjectMigrationInput) {
    return this.svc.start(user.userId, id, body);
  }

  /** `mc diff` per selected bucket: compares keys and sizes (not a content hash). */
  @Post(":id/verify")
  @HttpCode(200)
  @RequireScopes("write")
  verify(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.verify(user.userId, id);
  }

  /** Apply the exported anonymous policy / lifecycle / tags to the destination buckets (after the data). */
  @Post(":id/carry-config")
  @HttpCode(200)
  @RequireScopes("write")
  carryConfig(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.carryConfig(user.userId, id);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequireScopes("write")
  cancel(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.cancel(user.userId, id);
  }

  @Delete(":id")
  @RequireScopes("write")
  remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.remove(user.userId, id);
  }
}

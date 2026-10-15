import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { RedactSecretsInterceptor } from "../api-tokens/redact-secrets.interceptor";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthUser } from "../auth/strategies/jwt.strategy";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { APPLICATIONS_SERVICE } from "../applications/applications.tokens";
import type { ApplicationsService } from "../applications/applications.service";
import { AppViewSchema } from "../applications/applications.service";
import { FromTemplateSchema, type FromTemplateInput } from "../applications/dto";
import { TemplateCatalogService } from "./template-catalog.service";
import { CatalogEntrySchema } from "./dto";

/**
 * Public app-store (template catalog) API. Behind ApiAuthGuard+ScopesGuard so BOTH a browser session and
 * a PAT work; reads need `read`, deploy needs `deploy`. Only the secret-free `TemplateMeta` projection is
 * ever served — never the raw `TemplateDef` (which carries `composeFile`/`secrets`). Deploy delegates to
 * the same `ApplicationsService.createFromTemplate` the web uses; it is resolved lazily by string token
 * via ModuleRef because a static import of ApplicationsModule would form a cycle
 * (ApplicationsModule already imports CatalogModule for the read-side service).
 *
 * The AppView returned by a deploy carries a decrypted `webhookSecret` when the caller may read
 * secrets, so — exactly like ApplicationsController — this controller redacts it for scope-limited
 * PATs (a `deploy` token without `read:secrets`/`admin` sees it nulled; a browser session unchanged).
 */
@ApiTags("catalog")
@ApiSecurity("pat")
@Controller("catalog")
@UseGuards(ApiAuthGuard, ScopesGuard)
@UseInterceptors(new RedactSecretsInterceptor(["webhookSecret"]))
export class CatalogController {
  constructor(
    private readonly catalog: TemplateCatalogService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Browse the app store — the full list of deployable templates (gallery metadata only). */
  @Get()
  @ApiZodResponse(CatalogEntrySchema, { isArray: true })
  list() {
    return this.catalog.metaList();
  }

  /** One template's gallery metadata; 404 if the slug is unknown. */
  @Get(":slug")
  @ApiZodResponse(CatalogEntrySchema)
  get(@Param("slug") slug: string) {
    const entry = this.catalog.metaList().find((m) => m.slug === slug);
    if (!entry) throw new NotFoundException(`Unknown template: ${slug}`);
    return entry;
  }

  /**
   * Install a template as a new app (and, with `deploy:true`, deploy it) — the catalog-centric path for
   * the same `createFromTemplate` capability as `POST /apps/templates/:slug`. This route requires the
   * stricter `deploy` scope (the sibling route uses the `write` method-default); since it can stand up
   * and run infrastructure, `deploy` is the honest gate for a new endpoint. All real authorization (team
   * membership + per-team `apps:config`/`apps:deploy` permissions + server/environment ownership) is
   * enforced inside `createFromTemplate`; this endpoint adds no new authorization path.
   */
  @Post(":slug/deploy")
  @HttpCode(201)
  @RequireScopes("deploy")
  @ApiZodBody(FromTemplateSchema)
  @ApiZodResponse(AppViewSchema, { status: 201 })
  deploy(
    @CurrentUser() user: AuthUser,
    @Param("slug") slug: string,
    @Body(new ZodValidationPipe(FromTemplateSchema)) body: FromTemplateInput,
  ) {
    return this.moduleRef
      .get<ApplicationsService>(APPLICATIONS_SERVICE, { strict: false })
      .createFromTemplate(user.userId, slug, body);
  }
}

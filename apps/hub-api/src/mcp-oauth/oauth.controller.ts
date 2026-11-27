import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiCookieAuth, ApiExcludeController, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CsrfExempt } from "../common/csrf-exempt.decorator";
import { AllowUnverified } from "../common/allow-unverified.decorator";
import { hubBaseUrl, publicUrlFrom, type ReqLike } from "../common/hub-url";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import type { AuthUser } from "../auth/strategies/jwt.strategy";
import {
  McpOAuthService,
  authorizationServerMetadata,
  oauthError,
  protectedResourceMetadata,
  type AuthorizeParams,
  type OAuthOrigins,
} from "./oauth.service";

const NO_STORE = "no-store";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Public discovery documents. Served outside the /api/v1 prefix (see app-config). */
@ApiExcludeController()
@Controller()
export class McpOAuthMetadataController {
  constructor(private readonly config: ConfigService) {}

  private origins(req: ReqLike): OAuthOrigins {
    const issuer = hubBaseUrl(publicUrlFrom(req));
    const web = (this.config.get<string>("WEB_PUBLIC_URL")?.trim() || issuer).replace(/\/+$/, "");
    return { issuer, web };
  }

  // RFC 9728. Clients try the path-suffixed form for /api/v1/mcp first, then the bare one.
  @Get(".well-known/oauth-protected-resource")
  @Header("Cache-Control", "public, max-age=300")
  resource(@Req() req: ReqLike) {
    return protectedResourceMetadata(this.origins(req));
  }

  @Get(".well-known/oauth-protected-resource/api/v1/mcp")
  @Header("Cache-Control", "public, max-age=300")
  resourceForMcp(@Req() req: ReqLike) {
    return protectedResourceMetadata(this.origins(req));
  }

  // RFC 8414.
  @Get(".well-known/oauth-authorization-server")
  @Header("Cache-Control", "public, max-age=300")
  server(@Req() req: ReqLike) {
    return authorizationServerMetadata(this.origins(req));
  }
}

/** Registration, token and revocation endpoints: public clients, no cookie, no CSRF. */
@ApiExcludeController()
@Controller("oauth")
@CsrfExempt()
@AllowUnverified()
export class McpOAuthEndpointsController {
  constructor(private readonly oauth: McpOAuthService) {}

  @Post("register")
  @HttpCode(201)
  @Header("Cache-Control", NO_STORE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  register(@Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw oauthError("invalid_client_metadata", "send a JSON object");
    return this.oauth.register(body as Record<string, unknown>);
  }

  @Post("token")
  @HttpCode(200)
  @Header("Cache-Control", NO_STORE)
  @Header("Pragma", "no-cache")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  token(@Body() body: Record<string, unknown> | undefined) {
    const b = body ?? {};
    const grant = str(b.grant_type);
    if (grant === "authorization_code") {
      return this.oauth.exchangeCode({ code: str(b.code), code_verifier: str(b.code_verifier), client_id: str(b.client_id), redirect_uri: str(b.redirect_uri) });
    }
    if (grant === "refresh_token") {
      return this.oauth.refresh({ refresh_token: str(b.refresh_token), client_id: str(b.client_id) });
    }
    throw oauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }

  @Post("revoke")
  @HttpCode(200)
  @Header("Cache-Control", NO_STORE)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async revoke(@Body() body: Record<string, unknown> | undefined) {
    await this.oauth.revokeToken(str(body?.token), str(body?.client_id));
    return {};
  }
}

/** Only plain string parameters count; a repeated query key (an array) is treated as absent. */
function pickAuthorize(q: Record<string, unknown>): AuthorizeParams {
  return {
    response_type: str(q.response_type),
    client_id: str(q.client_id),
    redirect_uri: str(q.redirect_uri),
    code_challenge: str(q.code_challenge),
    code_challenge_method: str(q.code_challenge_method),
    scope: str(q.scope),
    state: str(q.state),
    resource: str(q.resource),
  };
}

const DecisionSchema = z.object({
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  scope: z.string().optional(),
  state: z.string().optional(),
  resource: z.string().optional(),
  approve: z.boolean(),
  teamId: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

/** The consent screen's API and the connected-clients list. Session login only, like the PAT management routes. */
@ApiTags("oauth")
@ApiCookieAuth("session")
@Controller("oauth")
@UseGuards(JwtAuthGuard)
export class McpOAuthConsentController {
  constructor(private readonly oauth: McpOAuthService) {}

  private resource(req: ReqLike): string {
    return `${hubBaseUrl(publicUrlFrom(req))}/api/v1/mcp`;
  }

  @Get("authorize/preview")
  @Header("Cache-Control", NO_STORE)
  preview(@CurrentUser() user: AuthUser, @Query() q: Record<string, unknown>, @Req() req: ReqLike) {
    return this.oauth.preview(user.userId, pickAuthorize(q), this.resource(req));
  }

  @Post("authorize/decision")
  @HttpCode(200)
  @Header("Cache-Control", NO_STORE)
  decide(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(DecisionSchema)) d: z.infer<typeof DecisionSchema>, @Req() req: ReqLike) {
    return this.oauth.decide(user.userId, pickAuthorize(d), { approve: d.approve, teamId: d.teamId, scopes: d.scopes }, this.resource(req), hubBaseUrl(publicUrlFrom(req)));
  }

  @Get("grants")
  grants(@CurrentUser() user: AuthUser) {
    return this.oauth.listGrants(user.userId);
  }

  @Delete("grants/:id")
  @HttpCode(200)
  async revokeGrant(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.oauth.revokeGrant(user.userId, id);
    return { ok: true };
  }
}

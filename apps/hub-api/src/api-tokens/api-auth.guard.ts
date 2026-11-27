import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { requestClientIp } from "../common/observed-ip";
import { ipMatchesAllowlist } from "../common/ip-allowlist";
import { ApiTokensService } from "./api-tokens.service";
import { isApiToken } from "./api-token.util";
import { describeApiUse } from "./api-token-usage";
import { hubBaseUrl, publicUrlFrom } from "../common/hub-url";
import { normalizeApiPath } from "../common/portal-surface";
import { isOAuthAccessToken, wwwAuthenticate } from "../mcp-oauth/oauth.util";
import type { McpOAuthService } from "../mcp-oauth/oauth.service";

/**
 * Accepts either a session JWT (delegates to JwtAuthGuard) or a personal access
 * token (`tugra_pat_…`). A superset of JwtAuthGuard, so existing JWT callers are
 * unaffected. Instance-level API gating (kill-switch + IP allowlist) is enforced
 * HERE in the PAT branch only — browser/JWT sessions are never gated.
 */
@Injectable()
export class ApiAuthGuard extends JwtAuthGuard {
  constructor(
    private readonly tokens: ApiTokensService,
    private readonly instance: InstanceSettingsService,
    // MCP OAuth bearer tokens (tugra_oat_…); absent in setups that do not wire the module.
    @Optional() private readonly oauth?: McpOAuthService,
  ) {
    super();
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    try {
      return await this.authenticate(ctx);
    } catch (e) {
      // MCP clients discover the authorization server from this challenge (MCP authorization spec, RFC 9728).
      if (e instanceof UnauthorizedException) {
        const req = ctx.switchToHttp().getRequest();
        if (isMcpRoute(req)) {
          const res = ctx.switchToHttp().getResponse?.();
          const challenge = wwwAuthenticate(`${hubBaseUrl(publicUrlFrom(req))}/.well-known/oauth-protected-resource/api/v1/mcp`);
          const hadToken = typeof req.headers?.authorization === "string" && req.headers.authorization.startsWith("Bearer ");
          res?.setHeader?.("WWW-Authenticate", hadToken ? `${challenge}, error="invalid_token"` : challenge);
        }
      }
      throw e;
    }
  }

  /** Instance-level API gating for token callers: the kill-switch and the IP allowlist. */
  private async gateApi(req: { headers?: unknown }): Promise<string | undefined> {
    const settings = await this.instance.get();
    if (!settings.apiEnabled) throw new ForbiddenException("api access is disabled");
    const ip = requestClientIp(req as never);
    if (settings.apiAllowedIps.length > 0) {
      if (!ip || !ipMatchesAllowlist(ip, settings.apiAllowedIps)) {
        throw new ForbiddenException("api access from this address is not allowed");
      }
    }
    return ip ?? undefined;
  }

  private async authenticate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth: string | undefined = req.headers?.authorization;
    const raw = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (this.oauth && isOAuthAccessToken(raw)) {
      // An OAuth grant is for MCP clients only; it never opens the rest of the REST API.
      if (!isMcpRoute(req)) throw new ForbiddenException("this token can only be used with the MCP endpoint");
      const user = await this.oauth.validateAccessToken(raw);
      if (!user) throw new UnauthorizedException("invalid or expired access token");
      await this.gateApi(req);
      req.user = user;
      return true;
    }
    if (isApiToken(raw)) {
      const user = await this.tokens.validate(raw);
      if (!user) throw new UnauthorizedException("invalid or expired api token");
      // PAT-only gating: a killed API or an off-allowlist source blocks the token, never the web session
      // (which takes the branch below). get() is read-only in steady state, so this is per-request safe.
      const ip = await this.gateApi(req);
      req.user = user;
      // Recent-use history (ip / agent / tool). Best-effort and off the request path: it must never fail or
      // slow an authorised call.
      if (user.tokenId) {
        const tokenId = user.tokenId;
        void Promise.resolve()
          .then(() => this.tokens.recordUse(tokenId, describeApiUse(req, ip ?? null)))
          .catch(() => undefined);
      }
      return true;
    }
    return (await super.canActivate(ctx)) as boolean;
  }
}

function isMcpRoute(req: { originalUrl?: string; url?: string }): boolean {
  return normalizeApiPath(req.originalUrl ?? req.url ?? "") === "/mcp";
}

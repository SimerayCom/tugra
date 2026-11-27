import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { hashToken } from "../api-tokens/api-token.util";
import { SCOPES, type Scope } from "../api-tokens/scopes";
import type { AuthUser } from "../auth/strategies/jwt.strategy";
import {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  REFRESH_TTL_MS,
  clampScopes,
  isAllowedRedirectUri,
  isValidCodeChallenge,
  maxScopesForPermissions,
  newAccessToken,
  newAuthCode,
  newRefreshToken,
  parseScopes,
  redirectHost,
  redirectUriMatches,
  verifyPkceS256,
} from "./oauth.util";

/** An RFC 6749 error response: `{ error, error_description }` (the global filter keeps both keys). */
export function oauthError(error: string, description: string, status = 400): HttpException {
  return new HttpException({ error, error_description: description, message: description }, status);
}

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  state?: string;
  resource?: string;
}

export interface ValidatedAuthorize {
  client: { id: string; name: string };
  redirectUri: string;
  requestedScopes: Scope[];
  codeChallenge: string;
  state?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const MAX_REDIRECT_URIS = 10;
const LAST_USED_STALE_MS = 60_000;

/** The public origin of this hub, plus where the consent page lives (same origin unless WEB_PUBLIC_URL differs). */
export interface OAuthOrigins {
  issuer: string;
  web: string;
}

export function protectedResourceMetadata(o: OAuthOrigins) {
  return {
    resource: `${o.issuer}/api/v1/mcp`,
    authorization_servers: [o.issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Tugra MCP",
  };
}

export function authorizationServerMetadata(o: OAuthOrigins) {
  return {
    issuer: o.issuer,
    authorization_endpoint: `${o.web}/oauth/authorize`,
    token_endpoint: `${o.issuer}/api/v1/oauth/token`,
    registration_endpoint: `${o.issuer}/api/v1/oauth/register`,
    revocation_endpoint: `${o.issuer}/api/v1/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

/** Where the protected-resource document for the MCP endpoint lives (advertised in WWW-Authenticate). */
export function resourceMetadataUrl(issuer: string): string {
  return `${issuer}/.well-known/oauth-protected-resource/api/v1/mcp`;
}


@Injectable()
export class McpOAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: TeamAccessService,
  ) {}

  // ---- dynamic client registration (RFC 7591) ----------------------------------------------------------

  async register(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
      throw oauthError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`);
    }
    for (const u of uris) {
      if (!isAllowedRedirectUri(u)) {
        throw oauthError("invalid_redirect_uri", "redirect URIs must be https, or http on localhost / 127.0.0.1, without a fragment");
      }
    }
    const method = body.token_endpoint_auth_method;
    if (method !== undefined && method !== "none") {
      throw oauthError("invalid_client_metadata", "only public clients are supported (token_endpoint_auth_method: none)");
    }
    const grantTypes = body.grant_types;
    if (grantTypes !== undefined) {
      const ok = Array.isArray(grantTypes) && grantTypes.every((g) => g === "authorization_code" || g === "refresh_token");
      if (!ok) throw oauthError("invalid_client_metadata", "grant_types may only contain authorization_code and refresh_token");
    }
    const rawName = typeof body.client_name === "string" ? body.client_name.trim() : "";
    const name = (rawName || "MCP client").slice(0, 100);
    const redirectUris = [...new Set(uris as string[])];
    await this.sweep();
    const client = await this.prisma.oAuthClient.create({ data: { name, redirectUris } });
    return {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    };
  }

  /** Drop spent codes and clients nobody ever consented to, so open registration cannot grow the table forever. */
  private async sweep(): Promise<void> {
    const now = Date.now();
    await Promise.all([
      this.prisma.oAuthCode.deleteMany({ where: { expiresAt: { lt: new Date(now - 3600_000) } } }),
      this.prisma.oAuthClient.deleteMany({ where: { createdAt: { lt: new Date(now - 86_400_000) }, grants: { none: {} } } }),
    ]).catch(() => undefined);
  }

  // ---- authorization (consent) ---------------------------------------------------------------------------

  /** Validate an authorization request. Throws 400 (nothing may redirect until the client + URI are verified). */
  async validateAuthorize(p: AuthorizeParams, expectedResource: string): Promise<ValidatedAuthorize> {
    if (p.response_type !== "code") throw oauthError("unsupported_response_type", "response_type must be code");
    if (!p.client_id) throw oauthError("invalid_request", "client_id is required");
    const client = await this.prisma.oAuthClient.findUnique({ where: { id: p.client_id } });
    if (!client) throw oauthError("invalid_request", "unknown client");
    let redirectUri = p.redirect_uri;
    if (!redirectUri && client.redirectUris.length === 1) redirectUri = client.redirectUris[0];
    if (!redirectUriMatches(client.redirectUris, redirectUri)) {
      throw oauthError("invalid_request", "redirect_uri does not match a registered URI");
    }
    if (p.code_challenge_method !== "S256") throw oauthError("invalid_request", "code_challenge_method must be S256");
    if (!isValidCodeChallenge(p.code_challenge)) throw oauthError("invalid_request", "code_challenge is missing or malformed");
    if (p.resource && p.resource.replace(/\/+$/, "") !== expectedResource) {
      throw oauthError("invalid_target", "resource does not identify this server");
    }
    const requestedScopes = parseScopes(p.scope);
    return {
      client: { id: client.id, name: client.name },
      redirectUri: redirectUri!,
      requestedScopes: requestedScopes.length ? requestedScopes : ["read"],
      codeChallenge: p.code_challenge,
      state: p.state,
    };
  }

  /** What the consent screen shows: the client, where it returns to, and per team what the user may grant. */
  async preview(userId: string, p: AuthorizeParams, expectedResource: string) {
    const v = await this.validateAuthorize(p, expectedResource);
    const perms = await this.access.permissionsByTeam(userId);
    const teams = perms.size
      ? await this.prisma.team.findMany({ where: { id: { in: [...perms.keys()] } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
      : [];
    return {
      client: v.client,
      redirectUri: v.redirectUri,
      redirectHost: redirectHost(v.redirectUri),
      requestedScopes: v.requestedScopes,
      teams: teams.map((t) => ({ id: t.id, name: t.name, allowedScopes: maxScopesForPermissions(perms.get(t.id) ?? new Set()) })),
    };
  }

  /** The user's decision. Returns the URL to send the browser to (the client's redirect URI with code or error). */
  async decide(
    userId: string,
    p: AuthorizeParams,
    decision: { approve: boolean; teamId?: string; scopes?: string[] },
    expectedResource: string,
    issuer: string,
  ): Promise<{ redirectTo: string }> {
    const v = await this.validateAuthorize(p, expectedResource);
    const back = new URL(v.redirectUri);
    back.searchParams.set("iss", issuer);
    if (v.state) back.searchParams.set("state", v.state);
    if (!decision.approve) {
      back.searchParams.set("error", "access_denied");
      return { redirectTo: back.toString() };
    }
    if (!decision.teamId) throw new BadRequestException("pick a team");
    const perms = await this.access.membershipPermissions(userId, decision.teamId);
    if (!perms) throw new ForbiddenException("you are not a member of this team");
    const picked = parseScopes((decision.scopes ?? []).join(" "));
    if (picked.length === 0) throw new BadRequestException("pick at least one scope");
    const allowed = new Set(maxScopesForPermissions(perms));
    const over = picked.filter((s) => !allowed.has(s));
    if (over.length) throw new ForbiddenException(`your role in this team does not allow: ${over.join(", ")}`);

    const raw = newAuthCode();
    await this.prisma.oAuthCode.create({
      data: {
        codeHash: hashToken(raw),
        clientId: v.client.id,
        userId,
        teamId: decision.teamId,
        scopes: picked,
        redirectUri: v.redirectUri,
        codeChallenge: v.codeChallenge,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
    back.searchParams.set("code", raw);
    await this.audit.log({ actor: userId, action: "oauth.consent", target: v.client.id, meta: { teamId: decision.teamId, scopes: picked } });
    return { redirectTo: back.toString() };
  }

  // ---- token endpoint -------------------------------------------------------------------------------------

  async exchangeCode(input: { code?: string; code_verifier?: string; client_id?: string; redirect_uri?: string }): Promise<TokenResponse> {
    const invalid = () => oauthError("invalid_grant", "the authorization code is invalid, expired or already used");
    if (!input.code || !input.client_id) throw oauthError("invalid_request", "code and client_id are required");
    const row = await this.prisma.oAuthCode.findUnique({ where: { codeHash: hashToken(input.code) } });
    if (!row) throw invalid();
    // Claim first: a code is spent by ANY attempt, so a guessed verifier gets exactly one try.
    const claimed = await this.prisma.oAuthCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) {
      // A replayed code: whatever it already produced is revoked (RFC 6749 4.1.2).
      if (row.grantId) await this.prisma.oAuthGrant.deleteMany({ where: { id: row.grantId } });
      throw invalid();
    }
    if (row.expiresAt.getTime() < Date.now()) throw invalid();
    if (row.clientId !== input.client_id) throw invalid();
    if (!input.redirect_uri || input.redirect_uri !== row.redirectUri) throw invalid();
    if (!input.code_verifier || !verifyPkceS256(input.code_verifier, row.codeChallenge)) throw invalid();
    // The user may have lost the team since consenting.
    const perms = await this.access.membershipPermissions(row.userId, row.teamId);
    if (!perms) throw invalid();

    const grant = await this.prisma.oAuthGrant.create({
      data: { userId: row.userId, clientId: row.clientId, teamId: row.teamId, scopes: clampScopes(row.scopes as Scope[], perms) },
    });
    await this.prisma.oAuthCode.update({ where: { id: row.id }, data: { grantId: grant.id } });
    return this.issue(grant.id, grant.scopes);
  }

  async refresh(input: { refresh_token?: string; client_id?: string }): Promise<TokenResponse> {
    const invalid = () => oauthError("invalid_grant", "the refresh token is invalid or expired");
    if (!input.refresh_token || !input.client_id) throw oauthError("invalid_request", "refresh_token and client_id are required");
    const row = await this.prisma.oAuthToken.findUnique({ where: { refreshHash: hashToken(input.refresh_token) }, include: { grant: true } });
    if (!row || row.grant.clientId !== input.client_id) throw invalid();
    const reuse = async () => {
      // A refresh token is used once. Seeing it again means a copy leaked: the whole family dies.
      await this.prisma.oAuthGrant.deleteMany({ where: { id: row.grantId } });
      await this.audit.log({ actor: row.grant.userId, action: "oauth.refresh_reuse", target: row.grantId }).catch(() => undefined);
      return invalid();
    };
    if (row.refreshUsedAt) throw await reuse();
    if (row.refreshExpiresAt.getTime() < Date.now()) throw invalid();
    const claimed = await this.prisma.oAuthToken.updateMany({ where: { id: row.id, refreshUsedAt: null }, data: { refreshUsedAt: new Date() } });
    if (claimed.count !== 1) throw await reuse();
    const perms = await this.access.membershipPermissions(row.grant.userId, row.grant.teamId);
    if (!perms) {
      await this.prisma.oAuthGrant.deleteMany({ where: { id: row.grantId } });
      throw invalid();
    }
    return this.issue(row.grantId, clampScopes(row.grant.scopes as Scope[], perms));
  }

  private async issue(grantId: string, scopes: string[]): Promise<TokenResponse> {
    const access = newAccessToken();
    const refresh = newRefreshToken();
    const now = Date.now();
    await this.prisma.oAuthToken.deleteMany({ where: { grantId, refreshExpiresAt: { lt: new Date(now) } } });
    await this.prisma.oAuthToken.create({
      data: {
        grantId,
        accessHash: hashToken(access),
        refreshHash: hashToken(refresh),
        accessExpiresAt: new Date(now + ACCESS_TTL_MS),
        refreshExpiresAt: new Date(now + REFRESH_TTL_MS),
      },
    });
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: scopes.join(" ") };
  }

  /** RFC 7009. Always succeeds from the caller's side; a known token revokes its whole grant. */
  async revokeToken(token: string | undefined, clientId: string | undefined): Promise<void> {
    if (!token) return;
    const hash = hashToken(token);
    const row = await this.prisma.oAuthToken.findFirst({ where: { OR: [{ accessHash: hash }, { refreshHash: hash }] }, include: { grant: true } });
    if (!row) return;
    if (clientId && row.grant.clientId !== clientId) return;
    await this.prisma.oAuthGrant.deleteMany({ where: { id: row.grantId } });
    await this.audit.log({ actor: row.grant.userId, action: "oauth.revoke", target: row.grantId, meta: { via: "revocation_endpoint" } }).catch(() => undefined);
  }

  // ---- bearer validation (ApiAuthGuard) ------------------------------------------------------------------

  /** Resolve a raw access token. Scopes are re-clamped to the member's CURRENT permissions on every call, so a
   *  demotion takes effect immediately and a token can never exceed the user's role. */
  async validateAccessToken(raw: string): Promise<AuthUser | null> {
    const row = await this.prisma.oAuthToken.findUnique({ where: { accessHash: hashToken(raw) }, include: { grant: true } });
    if (!row || row.accessExpiresAt.getTime() < Date.now()) return null;
    const perms = await this.access.membershipPermissions(row.grant.userId, row.grant.teamId);
    if (!perms) return null;
    const last = row.grant.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - last > LAST_USED_STALE_MS) {
      void this.prisma.oAuthGrant.update({ where: { id: row.grantId }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return {
      userId: row.grant.userId,
      scopes: clampScopes(row.grant.scopes as Scope[], perms),
      tokenId: `oauth:${row.grantId}`,
      oauthTeamId: row.grant.teamId,
    };
  }

  // ---- connected clients (settings) ------------------------------------------------------------------------

  async listGrants(userId: string) {
    const now = new Date();
    const grants = await this.prisma.oAuthGrant.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { client: { select: { name: true } }, tokens: { where: { refreshExpiresAt: { gt: now } }, select: { id: true }, take: 1 } },
    });
    const dead = grants.filter((g) => g.tokens.length === 0).map((g) => g.id);
    if (dead.length) await this.prisma.oAuthGrant.deleteMany({ where: { id: { in: dead } } }).catch(() => undefined);
    const live = grants.filter((g) => g.tokens.length > 0);
    const teamIds = [...new Set(live.map((g) => g.teamId))];
    const teams = teamIds.length ? await this.prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(teams.map((t) => [t.id, t.name]));
    return live.map((g) => ({
      id: g.id,
      clientName: g.client.name,
      teamId: g.teamId,
      teamName: names.get(g.teamId) ?? null,
      scopes: g.scopes,
      createdAt: g.createdAt,
      lastUsedAt: g.lastUsedAt,
    }));
  }

  async revokeGrant(userId: string, id: string): Promise<void> {
    const r = await this.prisma.oAuthGrant.deleteMany({ where: { id, userId } });
    if (r.count === 0) throw new NotFoundException("connection not found");
    await this.audit.log({ actor: userId, action: "oauth.revoke", target: id, meta: { via: "settings" } });
  }
}

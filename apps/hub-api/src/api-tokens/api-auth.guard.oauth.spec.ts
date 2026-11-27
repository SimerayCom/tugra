import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { ApiAuthGuard } from "./api-auth.guard";
import type { ApiTokensService } from "./api-tokens.service";
import type { InstanceSettingsService } from "../instance/instance-settings.service";
import type { McpOAuthService } from "../mcp-oauth/oauth.service";

function ctxFor(url: string, authorization?: string) {
  const req = { url, originalUrl: url, headers: { ...(authorization ? { authorization } : {}), host: "hub.test", "x-forwarded-proto": "https" }, socket: { remoteAddress: "1.2.3.4" }, user: undefined as unknown };
  const res = { setHeader: jest.fn() };
  const ctx = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext;
  return { ctx, req, res };
}

function guard(oauthUser: unknown = { userId: "u1", scopes: ["read"], tokenId: "oauth:g1", oauthTeamId: "team1" }, settings = { apiEnabled: true, apiAllowedIps: [] as string[] }) {
  const tokens = { validate: jest.fn().mockResolvedValue(null), recordUse: jest.fn() } as unknown as ApiTokensService;
  const instance = { get: jest.fn().mockResolvedValue(settings) } as unknown as InstanceSettingsService;
  const oauth = { validateAccessToken: jest.fn().mockResolvedValue(oauthUser) } as unknown as McpOAuthService;
  return { g: new ApiAuthGuard(tokens, instance, oauth), oauth, tokens };
}

describe("ApiAuthGuard — MCP OAuth tokens", () => {
  // No passport strategy in a unit test: stand in for the session-JWT branch rejecting a request with no session.
  beforeEach(() => {
    jest.spyOn(Object.getPrototypeOf(ApiAuthGuard.prototype), "canActivate").mockRejectedValue(new UnauthorizedException());
  });
  afterEach(() => jest.restoreAllMocks());

  it("accepts a valid OAuth token on the MCP endpoint and exposes its team", async () => {
    const { g } = guard();
    const { ctx, req } = ctxFor("/api/v1/mcp", "Bearer tugra_oat_abc");
    await expect(g.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({ userId: "u1", scopes: ["read"], tokenId: "oauth:g1", oauthTeamId: "team1" });
  });

  it("never opens the rest of the REST API to an OAuth token", async () => {
    const { g, oauth } = guard();
    await expect(g.canActivate(ctxFor("/api/v1/apps", "Bearer tugra_oat_abc").ctx)).rejects.toThrow(ForbiddenException);
    expect(oauth.validateAccessToken).not.toHaveBeenCalled();
  });

  it("answers an unknown OAuth token with 401 and the discovery challenge", async () => {
    const { g } = guard(null);
    const { ctx, res } = ctxFor("/api/v1/mcp", "Bearer tugra_oat_dead");
    await expect(g.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(res.setHeader).toHaveBeenCalledWith(
      "WWW-Authenticate",
      'Bearer resource_metadata="https://hub.test/.well-known/oauth-protected-resource/api/v1/mcp", error="invalid_token"',
    );
  });

  it("answers a request with no token with 401 and the bare discovery challenge", async () => {
    const { g } = guard();
    const { ctx, res } = ctxFor("/api/v1/mcp");
    await expect(g.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(res.setHeader).toHaveBeenCalledWith("WWW-Authenticate", 'Bearer resource_metadata="https://hub.test/.well-known/oauth-protected-resource/api/v1/mcp"');
  });

  it("does not add the challenge on other routes", async () => {
    const { g } = guard();
    const { ctx, res } = ctxFor("/api/v1/apps");
    await expect(g.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("applies the API kill-switch to OAuth tokens too", async () => {
    const { g } = guard(undefined, { apiEnabled: false, apiAllowedIps: [] });
    await expect(g.canActivate(ctxFor("/api/v1/mcp", "Bearer tugra_oat_abc").ctx)).rejects.toThrow(/disabled/);
  });

  it("keeps PAT auth on the MCP endpoint unchanged", async () => {
    const { g, tokens } = guard();
    (tokens.validate as jest.Mock).mockResolvedValue({ userId: "u2", scopes: ["read"], tokenId: "t1" });
    const { ctx, req } = ctxFor("/api/v1/mcp", "Bearer tugra_pat_xyz");
    await expect(g.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({ userId: "u2", scopes: ["read"], tokenId: "t1" });
  });
});

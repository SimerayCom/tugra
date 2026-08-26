import { Body, Controller, Get, Post, Res, UseGuards } from "@nestjs/common";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthUser } from "../auth/strategies/jwt.strategy";
import { RedisService } from "../redis/redis.service";
import { McpService } from "./mcp.service";

const BURST_WINDOW_SEC = 10;
const BURST_MAX = 30;

/** Minimal Express response shape we use (avoids a hard @types/express dependency — same pattern as
 *  oidc.controller's RedirectResponse). */
export interface McpHttpResponse {
  status(code: number): McpHttpResponse;
  setHeader(name: string, value: string): McpHttpResponse;
}

/**
 * MCP (Model Context Protocol) endpoint — `POST /api/v1/mcp`. Sits behind the same ApiAuthGuard +
 * ScopesGuard as the REST API, so a PAT (or browser session), the `apiEnabled` kill-switch and the API
 * IP-allowlist all apply automatically. `@RequireScopes("read")` lets any non-empty-scope token in;
 * per-tool scope is enforced inside McpService. Streamable-HTTP JSON transport (no SSE/stdio).
 */
@Controller("mcp")
@UseGuards(ApiAuthGuard, ScopesGuard)
@RequireScopes("read")
export class McpController {
  constructor(
    private readonly mcp: McpService,
    private readonly redis: RedisService,
  ) {}

  @Post()
  async handle(@CurrentUser() user: AuthUser, @Body() body: unknown, @Res({ passthrough: true }) res: McpHttpResponse) {
    const ctx = { userId: user.userId, scopes: user.scopes, tokenId: user.tokenId };

    // Per-user burst limit (fixed 10s window). Fail-open on a Redis hiccup — auth already gates access.
    const n = await this.redis.incr(`mcp:burst:${user.userId}`, BURST_WINDOW_SEC).catch(() => 0);
    if (n > BURST_MAX) {
      res.status(429);
      return { jsonrpc: "2.0", id: null, error: { code: -32000, message: "rate limit exceeded" } };
    }

    // JSON-RPC batch (array) or a single message. Notifications produce no response body.
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => this.mcp.handle(ctx, m)))).filter((r) => r !== null);
      if (out.length === 0) {
        res.status(202);
        return undefined;
      }
      return out;
    }
    const r = await this.mcp.handle(ctx, body as never);
    if (r === null) {
      res.status(202);
      return undefined;
    }
    return r;
  }

  @Get()
  getNotSupported(@Res({ passthrough: true }) res: McpHttpResponse) {
    // This server does not open an SSE stream; MCP clients should POST.
    res.status(405).setHeader("Allow", "POST");
    return { jsonrpc: "2.0", id: null, error: { code: -32000, message: "GET not supported; use POST" } };
  }
}

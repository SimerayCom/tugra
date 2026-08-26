import { Injectable, Logger } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { scopeSatisfies } from "../api-tokens/scopes";
import { ApplicationsService } from "../applications/applications.service";
import { ServersService } from "../servers/servers.service";
import { ClustersService } from "../clusters/clusters.service";
import { SwarmService } from "../clusters/swarm.service";
import { DatabasesService } from "../databases/databases.service";
import { BackupsService } from "../backups/backups.service";
import { MonitorsService } from "../monitors/monitors.service";
import { MCP_TOOLS, type McpDeps, type McpTool } from "./mcp-tools";
import { sanitizeToolResult } from "./tool-result-sanitizer";

const PROTOCOL_VERSION = "2025-06-18";

/** The caller context resolved by ApiAuthGuard from the PAT/session (never anything the client sends). */
export interface McpAuthCtx {
  userId: string;
  scopes: string[];
  tokenId?: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: unknown; protocolVersion?: string } & Record<string, unknown>;
}

/**
 * Minimal, spec-compliant MCP server over JSON-RPC 2.0 (Streamable-HTTP wire format), ported from the
 * an earlier project pattern. Phase1 exposes read-only tools; the caller's userId is always the one resolved from
 * the API token — the client can never widen its own team scope. Every tool result is sanitized before
 * it leaves for the (third-party) AI client.
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly deps: McpDeps;
  /** Overridable in tests; production always uses the real catalog. */
  tools: McpTool[] = MCP_TOOLS;

  constructor(
    apps: ApplicationsService,
    servers: ServersService,
    clusters: ClustersService,
    swarm: SwarmService,
    databases: DatabasesService,
    backups: BackupsService,
    monitors: MonitorsService,
    private readonly audit: AuditService,
  ) {
    this.deps = { apps, servers, clusters, swarm, databases, backups, monitors };
  }

  /** Handle one JSON-RPC message. Returns the response object, or null for notifications (no body). */
  async handle(ctx: McpAuthCtx, req: JsonRpcRequest): Promise<object | null> {
    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return this.error(req?.id ?? null, -32600, "Invalid Request");
    }
    const { id, method, params } = req;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case "initialize":
        return this.result(id, {
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "tugra-hub", version: "1.0.0" },
        });

      case "notifications/initialized":
      case "notifications/cancelled":
        return null; // acknowledged, no response

      case "ping":
        return this.result(id, {});

      case "tools/list":
        // #8: only advertise tools the token's scopes actually satisfy (scope-based visibility).
        return this.result(id, {
          tools: this.tools
            .filter((t) => scopeSatisfies(ctx.scopes, t.scope))
            .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });

      case "tools/call": {
        const name = params?.name;
        const tool = this.tools.find((t) => t.name === name);
        if (!tool) return this.error(id, -32602, `Unknown tool: ${name}`);
        // Enforce the tool's scope even if the client called it without it appearing in tools/list.
        if (!scopeSatisfies(ctx.scopes, tool.scope)) {
          return this.error(id, -32001, `Insufficient scope for tool: ${name} (requires ${tool.scope})`);
        }
        const args = params?.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
        try {
          const data = await tool.execute(this.deps, ctx.userId, args);
          const sanitized = sanitizeToolResult(data);
          this.auditCall(ctx, name!, args, "ok");
          return this.result(id, { content: [{ type: "text", text: JSON.stringify(sanitized) }] });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "tool call failed";
          this.logger.warn(`MCP tool ${name} failed: ${msg}`);
          this.auditCall(ctx, name!, args, "error");
          // MCP convention: tool failures are content with isError, NOT a JSON-RPC error.
          return this.result(id, { content: [{ type: "text", text: msg }], isError: true });
        }
      }

      default:
        if (isNotification) return null; // unknown notification — ignore
        return this.error(id, -32601, `Method not found: ${method}`);
    }
  }

  /** Fire-and-forget audit of every tool call — who (from the token, never the client), which tool, args
   *  (ids/filters only — read tools take no secrets), outcome. Never blocks or breaks the MCP response. */
  private auditCall(ctx: McpAuthCtx, tool: string, args: Record<string, unknown>, outcome: "ok" | "error"): void {
    this.audit
      .log({ actor: ctx.userId, action: "mcp.tools_call", target: tool, meta: { args, outcome, tokenId: ctx.tokenId ?? null } })
      .catch(() => undefined);
  }

  private result(id: JsonRpcRequest["id"], result: object) {
    return { jsonrpc: "2.0" as const, id: id ?? null, result };
  }

  private error(id: JsonRpcRequest["id"], code: number, message: string) {
    return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
  }
}

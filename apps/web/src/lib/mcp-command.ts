/** The MCP endpoint of a hub: Streamable-HTTP JSON-RPC, POST-only, behind the same Bearer token as the REST API. */
export function mcpUrl(hubOrigin: string): string {
  return `${hubOrigin.replace(/\/+$/, "")}/api/v1/mcp`;
}

/** The one-liner that registers this hub as an MCP server in Claude Code (HTTP transport, Bearer header).
 *  The token is base64url and the URL has no shell-special characters, so double quotes are enough. */
export function claudeMcpAddCommand(hubOrigin: string, token: string, serverName = "tugra"): string {
  return `claude mcp add --transport http ${serverName} ${mcpUrl(hubOrigin)} --header "Authorization: Bearer ${token}"`;
}

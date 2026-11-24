import { cleanText, describeApiCall, describeApiUse } from "./api-token-usage";

describe("describeApiCall", () => {
  it("labels an MCP tool call by tool name", () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_servers", arguments: {} } };
    expect(describeApiCall({ method: "POST", path: "/api/v1/mcp", body })).toBe("mcp:list_servers");
  });

  it("labels other MCP methods by method and a batch by its single tool or 'batch'", () => {
    expect(describeApiCall({ method: "POST", path: "/api/v1/mcp", body: { method: "tools/list" } })).toBe("mcp:tools/list");
    const call = (name: string) => ({ method: "tools/call", params: { name } });
    expect(describeApiCall({ method: "POST", path: "/api/v1/mcp", body: [call("a"), call("a")] })).toBe("mcp:a");
    expect(describeApiCall({ method: "POST", path: "/api/v1/mcp", body: [call("a"), call("b")] })).toBe("mcp:batch");
    expect(describeApiCall({ method: "POST", path: "/api/v1/mcp", body: "junk" })).toBe("mcp");
  });

  it("uses the route template (not the concrete URL) for REST calls", () => {
    expect(describeApiCall({ method: "get", path: "/api/v1/apps/abc123", route: { path: "/api/v1/apps/:id" } })).toBe("GET /api/v1/apps/:id");
  });

  it("drops the query string when no route template is available", () => {
    expect(describeApiCall({ method: "GET", originalUrl: "/api/v1/servers?token=zzz" })).toBe("GET /api/v1/servers");
  });

  it("returns null without any path", () => {
    expect(describeApiCall({ method: "GET" })).toBeNull();
  });
});

describe("describeApiUse / cleanText", () => {
  it("strips control characters and caps lengths", () => {
    expect(cleanText("a\r\nb\u0000c", 10)).toBe("a b c");
    expect(cleanText("x".repeat(500), 200)).toHaveLength(200);
    expect(cleanText("   ", 10)).toBeNull();
    expect(cleanText(42, 10)).toBeNull();
  });

  it("collects ip, user agent and action", () => {
    const u = describeApiUse({ method: "POST", path: "/api/v1/mcp", headers: { "user-agent": "claude-code/1.0" }, body: { method: "ping" } }, "203.0.113.7");
    expect(u).toEqual({ ip: "203.0.113.7", userAgent: "claude-code/1.0", action: "mcp:ping" });
  });

  it("never includes the authorization header value", () => {
    const u = describeApiUse({ method: "GET", path: "/x", headers: { authorization: "Bearer tugra_pat_SECRET", "user-agent": "curl/8" } }, null);
    expect(JSON.stringify(u)).not.toContain("SECRET");
    expect(u.ip).toBeNull();
  });
});

import { MCP_TOOLS, type McpDeps } from "./mcp-tools";

function tool(name: string) {
  const t = MCP_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe("MCP_TOOLS catalog", () => {
  it("every tool is read-only-scoped (read or read:secrets) with a name/description/inputSchema", () => {
    for (const t of MCP_TOOLS) {
      expect(["read", "read:secrets"]).toContain(t.scope); // Phase1 is read-only; no write/deploy/admin tools
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeTruthy();
    }
  });

  it("secret-bearing log tool (get_app_logs) requires read:secrets, not plain read", () => {
    expect(tool("get_app_logs").scope).toBe("read:secrets");
  });

  it("list_deployments strips the raw logs blob (metadata only — never leaks build secrets to the LLM)", async () => {
    const deployments = jest.fn().mockResolvedValue([
      { id: "d1", status: "SUCCESS", image: "nginx", logs: "DATABASE_URL=postgres://u:secret@h/db\n...", rollbackable: true },
    ]);
    const deps = { apps: { deployments } } as unknown as McpDeps;
    const res = (await tool("list_deployments").execute(deps, "u1", { id: "app1" })) as Array<Record<string, unknown>>;
    expect(deployments).toHaveBeenCalledWith("u1", "app1");
    expect(res[0].logs).toBeUndefined();
    expect(res[0].status).toBe("SUCCESS");
    expect(JSON.stringify(res)).not.toContain("secret");
  });

  it("passes the caller userId straight through to the service (team scoping stays server-side)", async () => {
    const get = jest.fn().mockResolvedValue({ id: "app1" });
    const deps = { apps: { get } } as unknown as McpDeps;
    await tool("get_application").execute(deps, "u1", { id: "app1" });
    expect(get).toHaveBeenCalledWith("u1", "app1");
  });

  it("get_server_capabilities verifies access via getForUser BEFORE the auth-less grantedCapabilities (#7)", async () => {
    const calls: string[] = [];
    const getForUser = jest.fn(async () => { calls.push("getForUser"); return { id: "s1" }; });
    const grantedCapabilities = jest.fn(async () => { calls.push("grantedCapabilities"); return ["deploy"]; });
    const deps = { servers: { getForUser, grantedCapabilities } } as unknown as McpDeps;
    const res = await tool("get_server_capabilities").execute(deps, "u1", { id: "s1" });
    expect(calls).toEqual(["getForUser", "grantedCapabilities"]); // access check first
    expect(getForUser).toHaveBeenCalledWith("u1", "s1");
    expect(res).toEqual({ capabilities: ["deploy"] });
  });

  it("get_server_capabilities never calls grantedCapabilities when access is denied", async () => {
    const getForUser = jest.fn().mockRejectedValue(new Error("forbidden"));
    const grantedCapabilities = jest.fn();
    const deps = { servers: { getForUser, grantedCapabilities } } as unknown as McpDeps;
    await expect(tool("get_server_capabilities").execute(deps, "u1", { id: "s1" })).rejects.toThrow(/forbidden/);
    expect(grantedCapabilities).not.toHaveBeenCalled();
  });

  it("get_app_env_keys returns KEY NAMES only, never values", async () => {
    const getEnv = jest.fn().mockResolvedValue({ DATABASE_URL: "postgres://secret", API_KEY: "sk_live_x" });
    const deps = { apps: { getEnv } } as unknown as McpDeps;
    const res = (await tool("get_app_env_keys").execute(deps, "u1", { id: "app1" })) as { keys: string[] };
    expect(res.keys.sort()).toEqual(["API_KEY", "DATABASE_URL"]);
    expect(JSON.stringify(res)).not.toContain("secret");
    expect(JSON.stringify(res)).not.toContain("sk_live_x");
  });

  it("clamps get_app_logs tail into 1..1000 (a client can bypass the advertised schema)", async () => {
    const appLogs = jest.fn().mockResolvedValue({ output: "" });
    const deps = { apps: { appLogs } } as unknown as McpDeps;
    await tool("get_app_logs").execute(deps, "u1", { id: "app1", tail: 999999 });
    expect(appLogs).toHaveBeenCalledWith("u1", "app1", 1000);
    await tool("get_app_logs").execute(deps, "u1", { id: "app1" }); // default
    expect(appLogs).toHaveBeenLastCalledWith("u1", "app1", 200);
  });

  it("throws on a missing required id argument (surfaced as a tool error)", async () => {
    const deps = { apps: { get: jest.fn() } } as unknown as McpDeps;
    // execute may throw synchronously (arg-validation before the promise) — the service's try/catch around
    // `await execute()` catches both; normalize to a rejection for the assertion.
    await expect(Promise.resolve().then(() => tool("get_application").execute(deps, "u1", {}))).rejects.toThrow(
      /missing required argument: id/,
    );
  });
});

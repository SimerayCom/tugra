import { MCP_TOOLS, type McpDeps } from "./mcp-tools";

function tool(name: string) {
  const t = MCP_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

const MUTATE_TOOLS = ["deploy_application", "restart_application", "stop_application", "start_application", "rollback_application"];

describe("MCP_TOOLS catalog", () => {
  it("every tool has a valid scope + name/description/inputSchema", () => {
    for (const t of MCP_TOOLS) {
      expect(["read", "read:secrets", "write", "deploy", "admin"]).toContain(t.scope);
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeTruthy();
    }
  });

  it("read tools stay read-scoped; the only mutate tools (Phase2a) are the deploy-tier app-lifecycle ones", () => {
    for (const t of MCP_TOOLS) {
      if (MUTATE_TOOLS.includes(t.name)) {
        expect(t.scope).toBe("deploy"); // mirrors the REST @RequireScopes("deploy") on the same routes
      } else {
        expect(["read", "read:secrets"]).toContain(t.scope); // everything else is still read-only
      }
    }
    // no accidental write/admin-tier tools slipped in this slice
    expect(MCP_TOOLS.filter((t) => t.scope === "write" || t.scope === "admin")).toEqual([]);
  });

  describe("mutate: application lifecycle (Phase2a)", () => {
    it("deploy_application redeploys via apps.deploy(userId,id) and STRIPS both logs AND configSnapshot (composeFile can hold secrets)", async () => {
      const deploy = jest.fn().mockResolvedValue({
        id: "d1", status: "SUCCESS", image: "nginx",
        logs: "DATABASE_URL=postgres://u:secret@h/db",
        configSnapshot: { composeFile: "services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: hunter2" },
      });
      const deps = { apps: { deploy } } as unknown as McpDeps;
      const res = (await tool("deploy_application").execute(deps, "u1", { id: "app1" })) as Record<string, unknown>;
      expect(deploy).toHaveBeenCalledWith("u1", "app1");
      expect(res.ok).toBe(true);
      expect(res.action).toBe("deploy");
      expect((res.deployment as Record<string, unknown>).logs).toBeUndefined();
      expect((res.deployment as Record<string, unknown>).configSnapshot).toBeUndefined(); // #F1
      expect((res.deployment as Record<string, unknown>).status).toBe("SUCCESS");
      expect(JSON.stringify(res)).not.toContain("secret");
      expect(JSON.stringify(res)).not.toContain("hunter2"); // compose secret never leaks
    });

    it("rollback_application redeploys a prior deployment via apps.rollback(userId,id,deploymentId), logs+configSnapshot stripped", async () => {
      const rollback = jest.fn().mockResolvedValue({ id: "d9", status: "SUCCESS", logs: "sk_live_leak", configSnapshot: { composeFile: "x: sk_compose_leak" } });
      const deps = { apps: { rollback } } as unknown as McpDeps;
      const res = (await tool("rollback_application").execute(deps, "u1", { id: "app1", deploymentId: "d3" })) as Record<string, unknown>;
      expect(rollback).toHaveBeenCalledWith("u1", "app1", "d3");
      expect((res.deployment as Record<string, unknown>).logs).toBeUndefined();
      expect((res.deployment as Record<string, unknown>).configSnapshot).toBeUndefined();
      expect(JSON.stringify(res)).not.toContain("sk_live_leak");
      expect(JSON.stringify(res)).not.toContain("sk_compose_leak");
    });

    it("rollback_application requires a deploymentId (throws when missing)", async () => {
      const deps = { apps: { rollback: jest.fn() } } as unknown as McpDeps;
      await expect(Promise.resolve().then(() => tool("rollback_application").execute(deps, "u1", { id: "app1" }))).rejects.toThrow(/missing required argument: deploymentId/);
    });

    for (const [name, method] of [["restart_application", "restart"], ["stop_application", "stop"], ["start_application", "start"]] as const) {
      it(`${name} calls apps.${method}(userId,id) then returns the fresh app view from apps.get`, async () => {
        const action = jest.fn().mockResolvedValue(undefined);
        const get = jest.fn().mockResolvedValue({ id: "app1", status: "RUNNING" });
        const deps = { apps: { [method]: action, get } } as unknown as McpDeps;
        const res = (await tool(name).execute(deps, "u1", { id: "app1" })) as Record<string, unknown>;
        expect(action).toHaveBeenCalledWith("u1", "app1");
        expect(get).toHaveBeenCalledWith("u1", "app1"); // follow-up read for the new status
        expect(res.ok).toBe(true);
        expect((res.application as Record<string, unknown>).status).toBe("RUNNING");
      });
    }

    it("lifecycle tools still report the action as done (application:null) if the follow-up get() throws (#F4)", async () => {
      // the mutate already took effect + audited; a concurrent delete making get() 404 must not imply it didn't
      const restart = jest.fn().mockResolvedValue(undefined);
      const get = jest.fn().mockRejectedValue(new Error("not found"));
      const deps = { apps: { restart, get } } as unknown as McpDeps;
      const res = (await tool("restart_application").execute(deps, "u1", { id: "app1" })) as Record<string, unknown>;
      expect(restart).toHaveBeenCalledWith("u1", "app1");
      expect(res.ok).toBe(true);
      expect(res.application).toBeNull();
    });

    it("every lifecycle tool throws on a missing id", async () => {
      const deps = { apps: { deploy: jest.fn(), restart: jest.fn(), stop: jest.fn(), start: jest.fn(), rollback: jest.fn() } } as unknown as McpDeps;
      for (const name of MUTATE_TOOLS) {
        await expect(Promise.resolve().then(() => tool(name).execute(deps, "u1", {}))).rejects.toThrow(/missing required argument: id/);
      }
    });
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

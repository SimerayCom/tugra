import { MCP_TOOLS, type McpDeps } from "./mcp-tools";

function tool(name: string) {
  const t = MCP_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

const LIFECYCLE_TOOLS = ["deploy_application", "restart_application", "stop_application", "start_application", "rollback_application"];
const DEPLOY_TOOLS = [...LIFECYCLE_TOOLS, "form_swarm", "join_swarm_node", "add_swarm_manager", "set_ingress_replicas"];
const ADMIN_TOOLS = ["dissolve_swarm", "remove_application"];

describe("MCP_TOOLS catalog", () => {
  it("every tool has a valid scope + name/description/inputSchema", () => {
    for (const t of MCP_TOOLS) {
      expect(["read", "read:secrets", "write", "deploy", "admin"]).toContain(t.scope);
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeTruthy();
    }
  });

  it("mutate tools carry the scope of their REST route: deploy-tier ops = deploy, destructive = admin; everything else read", () => {
    for (const t of MCP_TOOLS) {
      if (DEPLOY_TOOLS.includes(t.name)) expect(t.scope).toBe("deploy");
      else if (ADMIN_TOOLS.includes(t.name)) expect(t.scope).toBe("admin");
      else expect(["read", "read:secrets"]).toContain(t.scope);
    }
    // we deliberately mirror the routes' effective scope (deploy / admin) — never plain "write"
    expect(MCP_TOOLS.filter((t) => t.scope === "write")).toEqual([]);
    // the destructive tier must not be reachable with a mere deploy token
    for (const name of ADMIN_TOOLS) expect(tool(name).scope).toBe("admin");
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
      for (const name of LIFECYCLE_TOOLS) {
        await expect(Promise.resolve().then(() => tool(name).execute(deps, "u1", {}))).rejects.toThrow(/missing required argument: id/);
      }
    });
  });

  describe("mutate: cluster / swarm operation (Phase2b)", () => {
    it("form_swarm delegates to swarm.form with the parsed manager + advertiseAddr", async () => {
      const form = jest.fn().mockResolvedValue({ swarmStatus: "ACTIVE" });
      const deps = { swarm: { form } } as unknown as McpDeps;
      const res = (await tool("form_swarm").execute(deps, "u1", { clusterId: "c1", managerServerId: "s1", advertiseAddr: "10.0.0.5" })) as Record<string, unknown>;
      expect(form).toHaveBeenCalledWith("u1", "c1", { managerServerId: "s1", advertiseAddr: "10.0.0.5" });
      expect(res).toMatchObject({ ok: true, action: "form_swarm", swarm: { swarmStatus: "ACTIVE" } });
    });

    it("join_swarm_node delegates to swarm.joinNode", async () => {
      const joinNode = jest.fn().mockResolvedValue({ swarmStatus: "ACTIVE" });
      const deps = { swarm: { joinNode } } as unknown as McpDeps;
      await tool("join_swarm_node").execute(deps, "u1", { clusterId: "c1", serverId: "s2" });
      expect(joinNode).toHaveBeenCalledWith("u1", "c1", { serverId: "s2", advertiseAddr: undefined });
    });

    it("add_swarm_manager passes acknowledgeEvenQuorum through as a real boolean", async () => {
      const addManager = jest.fn().mockResolvedValue({ swarmStatus: "ACTIVE" });
      const deps = { swarm: { addManager } } as unknown as McpDeps;
      await tool("add_swarm_manager").execute(deps, "u1", { clusterId: "c1", serverId: "s2", acknowledgeEvenQuorum: true });
      expect(addManager).toHaveBeenCalledWith("u1", "c1", { serverId: "s2", acknowledgeEvenQuorum: true });
      await tool("add_swarm_manager").execute(deps, "u1", { clusterId: "c1", serverId: "s2" });
      expect(addManager).toHaveBeenLastCalledWith("u1", "c1", { serverId: "s2", acknowledgeEvenQuorum: false }); // default false, never undefined
    });

    it("set_ingress_replicas clamps an in-range-but-out-of-bounds valid count into 1..3", async () => {
      const setIngressReplicas = jest.fn().mockResolvedValue({ replicas: 3, nodes: [] });
      const deps = { swarm: { setIngressReplicas } } as unknown as McpDeps;
      await tool("set_ingress_replicas").execute(deps, "u1", { clusterId: "c1", replicas: 99 });
      expect(setIngressReplicas).toHaveBeenCalledWith("u1", "c1", 3);
    });

    it("set_ingress_replicas THROWS on a missing/garbage required replicas (never silently drops HA to 1) (#F1)", async () => {
      const setIngressReplicas = jest.fn();
      const deps = { swarm: { setIngressReplicas } } as unknown as McpDeps;
      for (const bad of [{ clusterId: "c1" }, { clusterId: "c1", replicas: null }, { clusterId: "c1", replicas: "3" }, { clusterId: "c1", replicas: NaN }]) {
        await expect(Promise.resolve().then(() => tool("set_ingress_replicas").execute(deps, "u1", bad as Record<string, unknown>))).rejects.toThrow(/replicas/);
      }
      expect(setIngressReplicas).not.toHaveBeenCalled(); // never proceeds on invalid input
    });

    it("dissolve_swarm requires confirmName == the cluster's exact name (reads it via clusters.get first)", async () => {
      const dissolve = jest.fn().mockResolvedValue({ swarmStatus: "NONE" });
      const get = jest.fn().mockResolvedValue({ id: "c1", name: "eu-west" });
      const deps = { clusters: { get }, swarm: { dissolve } } as unknown as McpDeps;
      // wrong name → refused, dissolve NEVER called
      await expect(Promise.resolve().then(() => tool("dissolve_swarm").execute(deps, "u1", { clusterId: "c1", confirmName: "wrong" }))).rejects.toThrow(/confirmName.*eu-west/);
      expect(dissolve).not.toHaveBeenCalled();
      // exact name → proceeds
      const res = (await tool("dissolve_swarm").execute(deps, "u1", { clusterId: "c1", confirmName: "eu-west" })) as Record<string, unknown>;
      expect(get).toHaveBeenCalledWith("u1", "c1"); // read-gated name lookup happened first
      expect(dissolve).toHaveBeenCalledWith("u1", "c1");
      expect(res).toMatchObject({ ok: true, action: "dissolve_swarm" });
    });
  });

  describe("mutate: application removal (Phase2b, destructive)", () => {
    it("remove_application requires confirmName == the app's exact name; never removes on mismatch", async () => {
      const remove = jest.fn().mockResolvedValue(undefined);
      const get = jest.fn().mockResolvedValue({ id: "app1", name: "api" });
      const deps = { apps: { get, remove } } as unknown as McpDeps;
      await expect(Promise.resolve().then(() => tool("remove_application").execute(deps, "u1", { id: "app1", confirmName: "nope" }))).rejects.toThrow(/confirmName.*api/);
      expect(remove).not.toHaveBeenCalled();
      const res = (await tool("remove_application").execute(deps, "u1", { id: "app1", confirmName: "api" })) as Record<string, unknown>;
      expect(remove).toHaveBeenCalledWith("u1", "app1");
      expect(res).toMatchObject({ ok: true, action: "remove_application", id: "app1" });
    });

    it("remove_application requires confirmName even when omitted (undefined never matches a real name)", async () => {
      const remove = jest.fn();
      const get = jest.fn().mockResolvedValue({ id: "app1", name: "api" });
      const deps = { apps: { get, remove } } as unknown as McpDeps;
      await expect(Promise.resolve().then(() => tool("remove_application").execute(deps, "u1", { id: "app1" }))).rejects.toThrow(/confirmName/);
      expect(remove).not.toHaveBeenCalled();
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

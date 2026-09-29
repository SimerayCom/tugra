import { MCP_TOOLS, type McpDeps } from "./mcp-tools";

function tool(name: string) {
  const t = MCP_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

const LIFECYCLE_TOOLS = ["deploy_application", "restart_application", "stop_application", "start_application", "rollback_application", "scale_application"];
const DEPLOY_TOOLS = [...LIFECYCLE_TOOLS, "form_swarm", "join_swarm_node", "add_swarm_manager", "set_ingress_replicas", "fleet_app_action"];
const WRITE_TOOLS = ["set_env_var", "delete_env_var"];
const ADMIN_TOOLS = ["dissolve_swarm", "remove_application", "remove_swarm_manager", "leave_swarm_node"];

describe("MCP_TOOLS catalog", () => {
  it("every tool has a valid scope + name/description/inputSchema", () => {
    for (const t of MCP_TOOLS) {
      expect(["read", "read:secrets", "write", "deploy", "admin"]).toContain(t.scope);
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeTruthy();
    }
  });

  it("mutate tools carry the scope of their REST route: config=write, deploy-tier ops=deploy, destructive=admin; else read", () => {
    for (const t of MCP_TOOLS) {
      if (DEPLOY_TOOLS.includes(t.name)) expect(t.scope).toBe("deploy");
      else if (ADMIN_TOOLS.includes(t.name)) expect(t.scope).toBe("admin");
      else if (WRITE_TOOLS.includes(t.name)) expect(t.scope).toBe("write");
      else expect(["read", "read:secrets"]).toContain(t.scope);
    }
    // the write-scoped tools are EXACTLY the env-config ones (mirror PUT :id/env's default scope)
    expect(MCP_TOOLS.filter((t) => t.scope === "write").map((t) => t.name).sort()).toEqual([...WRITE_TOOLS].sort());
    // the destructive/admin tier must not be reachable with a mere deploy/write token
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

  describe("mutate: application scale (Phase2e)", () => {
    it("scale_application live-scales via scaleNow(userId,id,replicas), then returns the fresh app view", async () => {
      const scaleNow = jest.fn().mockResolvedValue(undefined);
      const get = jest.fn().mockResolvedValue({ id: "app1", status: "RUNNING", replicas: 3 });
      const deps = { apps: { scaleNow, get } } as unknown as McpDeps;
      const res = (await tool("scale_application").execute(deps, "u1", { id: "app1", replicas: 3 })) as Record<string, unknown>;
      expect(scaleNow).toHaveBeenCalledWith("u1", "app1", 3);
      expect(res).toMatchObject({ ok: true, action: "scale", replicas: 3 });
      expect((res.application as Record<string, unknown>).status).toBe("RUNNING");
    });

    it("scale_application clamps replicas into 1..20 and throws on a missing/garbage count", async () => {
      const scaleNow = jest.fn().mockResolvedValue(undefined);
      const get = jest.fn().mockResolvedValue({ id: "app1" });
      const deps = { apps: { scaleNow, get } } as unknown as McpDeps;
      await tool("scale_application").execute(deps, "u1", { id: "app1", replicas: 99 });
      expect(scaleNow).toHaveBeenLastCalledWith("u1", "app1", 20); // clamped to the ceiling
      await expect(Promise.resolve().then(() => tool("scale_application").execute(deps, "u1", { id: "app1" }))).rejects.toThrow(/replicas/);
    });

    it("scale_application still reports the action done (application:null) if the follow-up get() throws", async () => {
      const scaleNow = jest.fn().mockResolvedValue(undefined);
      const get = jest.fn().mockRejectedValue(new Error("not found"));
      const deps = { apps: { scaleNow, get } } as unknown as McpDeps;
      const res = (await tool("scale_application").execute(deps, "u1", { id: "app1", replicas: 2 })) as Record<string, unknown>;
      expect(res).toEqual({ ok: true, action: "scale", replicas: 2, application: null });
    });
  });

  describe("mutate: application env config (Phase2c)", () => {
    it("set_env_var MERGES one key (preserves others) via getEnv+setEnv and NEVER returns the value", async () => {
      const getEnv = jest.fn().mockResolvedValue({ EXISTING: "keep", API_KEY: "old" });
      const setEnv = jest.fn().mockResolvedValue(undefined);
      const deps = { apps: { getEnv, setEnv } } as unknown as McpDeps;
      const res = (await tool("set_env_var").execute(deps, "u1", { id: "app1", key: "API_KEY", value: "sk_new_secret" })) as Record<string, unknown>;
      expect(getEnv).toHaveBeenCalledWith("u1", "app1");
      expect(setEnv).toHaveBeenCalledWith("u1", "app1", { EXISTING: "keep", API_KEY: "sk_new_secret" }); // merged, other var kept
      expect(res).toEqual({ ok: true, action: "set_env_var", key: "API_KEY" });
      expect(JSON.stringify(res)).not.toContain("sk_new_secret"); // value never echoed back
    });

    it("set_env_var allows an empty value but rejects an invalid/reserved env key name (agent-supplied)", async () => {
      const getEnv = jest.fn().mockResolvedValue({});
      const setEnv = jest.fn().mockResolvedValue(undefined);
      const deps = { apps: { getEnv, setEnv } } as unknown as McpDeps;
      await tool("set_env_var").execute(deps, "u1", { id: "app1", key: "FLAG", value: "" }); // empty value OK
      expect(setEnv).toHaveBeenCalledWith("u1", "app1", { FLAG: "" });
      await expect(Promise.resolve().then(() => tool("set_env_var").execute(deps, "u1", { id: "app1", key: "BAD=KEY", value: "x" }))).rejects.toThrow(/invalid env var name/);
      // reserved / prototype-ish names are rejected even though the regex would admit the underscore/letters
      for (const bad of ["__proto__", "constructor", "prototype"]) {
        await expect(Promise.resolve().then(() => tool("set_env_var").execute(deps, "u1", { id: "app1", key: bad, value: "x" }))).rejects.toThrow(/invalid env var name/);
      }
      await expect(Promise.resolve().then(() => tool("set_env_var").execute(deps, "u1", { id: "app1", key: "K" }))).rejects.toThrow(/missing required argument: value/);
    });

    it("set_env_var declares its value arg as sensitive (so the MCP server redacts it from the audit log)", () => {
      expect(tool("set_env_var").sensitiveArgs).toEqual(["value"]);
    });

    it("delete_env_var removes one key; is a no-op (removed:false, no setEnv) when the key is absent", async () => {
      const setEnv = jest.fn().mockResolvedValue(undefined);
      const getEnv = jest.fn().mockResolvedValue({ A: "1", B: "2" });
      const deps = { apps: { getEnv, setEnv } } as unknown as McpDeps;
      const res = (await tool("delete_env_var").execute(deps, "u1", { id: "app1", key: "A" })) as Record<string, unknown>;
      expect(setEnv).toHaveBeenCalledWith("u1", "app1", { B: "2" });
      expect(res).toEqual({ ok: true, action: "delete_env_var", key: "A", removed: true });
      setEnv.mockClear();
      const res2 = (await tool("delete_env_var").execute(deps, "u1", { id: "app1", key: "MISSING" })) as Record<string, unknown>;
      expect(setEnv).not.toHaveBeenCalled();
      expect(res2).toEqual({ ok: true, action: "delete_env_var", key: "MISSING", removed: false });
    });

    it("delete_env_var uses an OWN-property check: an inherited name like 'toString' reports removed:false, no write (#F2/F3)", async () => {
      const setEnv = jest.fn().mockResolvedValue(undefined);
      const getEnv = jest.fn().mockResolvedValue({ REAL: "1" }); // plain object → inherits toString/valueOf via the chain
      const deps = { apps: { getEnv, setEnv } } as unknown as McpDeps;
      const res = (await tool("delete_env_var").execute(deps, "u1", { id: "app1", key: "toString" })) as Record<string, unknown>;
      expect(res).toEqual({ ok: true, action: "delete_env_var", key: "toString", removed: false });
      expect(setEnv).not.toHaveBeenCalled(); // no spurious re-encrypt+write of an unchanged env
    });
  });

  describe("mutate: swarm node removal (Phase2c)", () => {
    it("remove_swarm_manager delegates to swarm.removeManager with acknowledgeEvenQuorum as a boolean", async () => {
      const removeManager = jest.fn().mockResolvedValue({ swarmStatus: "ACTIVE" });
      const deps = { swarm: { removeManager } } as unknown as McpDeps;
      await tool("remove_swarm_manager").execute(deps, "u1", { clusterId: "c1", serverId: "s2", acknowledgeEvenQuorum: true });
      expect(removeManager).toHaveBeenCalledWith("u1", "c1", { serverId: "s2", acknowledgeEvenQuorum: true });
    });
    it("leave_swarm_node delegates to swarm.leaveNode(userId, clusterId, serverId)", async () => {
      const leaveNode = jest.fn().mockResolvedValue({ swarmStatus: "ACTIVE" });
      const deps = { swarm: { leaveNode } } as unknown as McpDeps;
      const res = (await tool("leave_swarm_node").execute(deps, "u1", { clusterId: "c1", serverId: "s2" })) as Record<string, unknown>;
      expect(leaveNode).toHaveBeenCalledWith("u1", "c1", "s2");
      expect(res).toMatchObject({ ok: true, action: "leave_swarm_node" });
    });
  });

  describe("mutate: fleet (Phase2d)", () => {
    const clusterApps = () => [
      { id: "a1", name: "api", clusterId: "c1", status: "RUNNING" },
      { id: "a2", name: "web", clusterId: "c1", status: "RUNNING" },
      { id: "a3", name: "other", clusterId: "c2", status: "RUNNING" }, // different cluster — must be excluded
      { id: "a4", name: "solo", clusterId: null, status: "RUNNING" }, // not clustered — excluded
    ];
    const fleetTool = tool("fleet_app_action");
    const preview = async (deps: McpDeps, args: Record<string, unknown>) => (await fleetTool.execute(deps, "u1", args)) as Record<string, unknown>;

    it("previews (no confirmToken) the cluster's apps ONLY, returns a confirmToken, performs NO action", async () => {
      const restart = jest.fn();
      const list = jest.fn().mockResolvedValue(clusterApps());
      const deps = { apps: { list, restart } } as unknown as McpDeps;
      const res = await preview(deps, { clusterId: "c1", action: "restart" });
      expect(res.preview).toBe(true);
      expect(res.count).toBe(2);
      expect((res.targets as Array<{ id: string }>).map((t) => t.id)).toEqual(["a1", "a2"]); // c2/null excluded
      expect(typeof res.confirmToken).toBe("string");
      expect(restart).not.toHaveBeenCalled(); // preview never acts
    });

    it("executes on every cluster app when the previewed confirmToken is echoed (bounded-concurrency), collecting per-app results", async () => {
      const restart = jest.fn().mockResolvedValue(undefined);
      const list = jest.fn().mockResolvedValue(clusterApps());
      const deps = { apps: { list, restart } } as unknown as McpDeps;
      const token = (await preview(deps, { clusterId: "c1", action: "restart" })).confirmToken as string;
      const res = await preview(deps, { clusterId: "c1", action: "restart", confirmToken: token });
      expect(restart).toHaveBeenCalledWith("u1", "a1");
      expect(restart).toHaveBeenCalledWith("u1", "a2");
      expect(restart).toHaveBeenCalledTimes(2);
      expect(res).toMatchObject({ ok: true, preview: false, action: "restart", succeeded: 2, failed: 0 });
    });

    it("a per-app failure is collected (not fatal) — the rest still run", async () => {
      const restart = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("app offline"));
      const list = jest.fn().mockResolvedValue(clusterApps());
      const deps = { apps: { list, restart } } as unknown as McpDeps;
      const token = (await preview(deps, { clusterId: "c1", action: "restart" })).confirmToken as string;
      const res = await preview(deps, { clusterId: "c1", action: "restart", confirmToken: token });
      expect(res).toMatchObject({ succeeded: 1, failed: 1 });
      expect((res.results as Array<{ ok: boolean; error?: string }>).find((r) => !r.ok)?.error).toMatch(/app offline/);
    });

    it("the confirmToken binds the ACTION: a token previewed for restart cannot confirm stop (#F5)", async () => {
      const restart = jest.fn();
      const stop = jest.fn();
      const list = jest.fn().mockResolvedValue(clusterApps());
      const deps = { apps: { list, restart, stop } } as unknown as McpDeps;
      const restartToken = (await preview(deps, { clusterId: "c1", action: "restart" })).confirmToken as string;
      await expect(preview(deps, { clusterId: "c1", action: "stop", confirmToken: restartToken })).rejects.toThrow(/stale or mismatched/);
      expect(stop).not.toHaveBeenCalled();
    });

    it("the confirmToken binds the TARGET SET: a same-count membership swap between preview and execute is refused (#F2/F3/F6)", async () => {
      const restart = jest.fn();
      const list = jest.fn();
      const deps = { apps: { list, restart } } as unknown as McpDeps;
      list.mockResolvedValueOnce(clusterApps()); // preview sees {a1,a2}
      const token = (await preview(deps, { clusterId: "c1", action: "restart" })).confirmToken as string;
      // between preview and execute, a2 leaves c1 and a5 joins — SAME count (2) but different identity
      list.mockResolvedValueOnce([
        { id: "a1", name: "api", clusterId: "c1", status: "RUNNING" },
        { id: "a5", name: "new", clusterId: "c1", status: "RUNNING" },
      ]);
      await expect(preview(deps, { clusterId: "c1", action: "restart", confirmToken: token })).rejects.toThrow(/stale or mismatched/);
      expect(restart).not.toHaveBeenCalled();
    });

    it("caps the fan-out: >MAX targets previews with tooMany and refuses to execute (#F1/F4/F7)", async () => {
      const restart = jest.fn();
      const many = Array.from({ length: 26 }, (_v, i) => ({ id: `a${i}`, name: `app${i}`, clusterId: "c1", status: "RUNNING" }));
      const list = jest.fn().mockResolvedValue(many);
      const deps = { apps: { list, restart } } as unknown as McpDeps;
      const pv = await preview(deps, { clusterId: "c1", action: "restart" });
      expect(pv.tooMany).toBe(true);
      await expect(preview(deps, { clusterId: "c1", action: "restart", confirmToken: pv.confirmToken as string })).rejects.toThrow(/too many target apps/);
      expect(restart).not.toHaveBeenCalled();
    });

    it("rejects an action outside the reversible allowlist (never fans a destructive/arbitrary verb)", async () => {
      const remove = jest.fn();
      const list = jest.fn().mockResolvedValue(clusterApps());
      const deps = { apps: { list, remove } } as unknown as McpDeps;
      for (const bad of ["remove", "deploy", "rm -rf", "delete"]) {
        await expect(Promise.resolve().then(() => fleetTool.execute(deps, "u1", { clusterId: "c1", action: bad, confirmToken: "x" }))).rejects.toThrow(/action must be one of/);
      }
      expect(remove).not.toHaveBeenCalled();
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

import { McpService, type McpAuthCtx } from "./mcp.service";
import type { AuditService } from "../audit/audit.service";
import type { McpTool } from "./mcp-tools";

function make() {
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const empty = {} as never;
  const svc = new McpService(empty, empty, empty, empty, empty, empty, empty, audit);
  return { svc, audit };
}

const ctx = (scopes: string[]): McpAuthCtx => ({ userId: "u1", scopes, tokenId: "t1" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpc = (method: string, params?: any, id: number | null = 1) => ({ jsonrpc: "2.0", id, method, params });

function toolStub(name: string, scope: McpTool["scope"], execute: McpTool["execute"]): McpTool {
  return { name, description: name, scope, inputSchema: { type: "object", properties: {} }, execute };
}

describe("McpService.handle", () => {
  it("initialize returns protocolVersion + tools capability + serverInfo", async () => {
    const { svc } = make();
    const res = (await svc.handle(ctx(["read"]), rpc("initialize", {}))) as { result: Record<string, unknown> };
    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect(res.result.capabilities).toEqual({ tools: {} });
    expect(res.result.serverInfo).toMatchObject({ name: "tugra-hub" });
  });

  it("ping → {}, notifications → null (no body)", async () => {
    const { svc } = make();
    expect((await svc.handle(ctx(["read"]), rpc("ping"))) as { result: unknown }).toMatchObject({ result: {} });
    expect(await svc.handle(ctx(["read"]), { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("rejects a malformed request (-32600) and an unknown method (-32601)", async () => {
    const { svc } = make();
    expect((await svc.handle(ctx(["read"]), { jsonrpc: "1.0", method: "x", id: 1 })) as { error: { code: number } }).toMatchObject({ error: { code: -32600 } });
    expect((await svc.handle(ctx(["read"]), rpc("does/not/exist"))) as { error: { code: number } }).toMatchObject({ error: { code: -32601 } });
    // unknown NOTIFICATION (no id) is ignored, not errored
    expect(await svc.handle(ctx(["read"]), { jsonrpc: "2.0", method: "notifications/unknown" })).toBeNull();
  });

  it("tools/list advertises only the tools the token's scopes satisfy (#8)", async () => {
    const { svc } = make();
    svc.tools = [
      toolStub("read_tool", "read", async () => ({})),
      toolStub("deploy_tool", "deploy", async () => ({})),
    ];
    const res = (await svc.handle(ctx(["read"]), rpc("tools/list"))) as { result: { tools: { name: string }[] } };
    const names = res.result.tools.map((t) => t.name);
    expect(names).toEqual(["read_tool"]); // deploy_tool hidden from a read-only token
  });

  it("tools/call: unknown tool → -32602", async () => {
    const { svc } = make();
    const res = (await svc.handle(ctx(["read"]), rpc("tools/call", { name: "nope" }))) as { error: { code: number } };
    expect(res.error.code).toBe(-32602);
  });

  it("tools/call: insufficient scope → -32001 (never executes)", async () => {
    const { svc } = make();
    const execute = jest.fn();
    svc.tools = [toolStub("deploy_tool", "deploy", execute)];
    const res = (await svc.handle(ctx(["read"]), rpc("tools/call", { name: "deploy_tool" }))) as { error: { code: number } };
    expect(res.error.code).toBe(-32001);
    expect(execute).not.toHaveBeenCalled();
  });

  it("tools/call: success wraps the sanitized result in MCP content + audits", async () => {
    const { svc, audit } = make();
    svc.tools = [toolStub("get_thing", "read", async (_d, userId) => ({ userId, password: "leak", ok: 1 }))];
    const res = (await svc.handle(ctx(["read"]), rpc("tools/call", { name: "get_thing", arguments: { id: "x" } }))) as {
      result: { content: { type: string; text: string }[] };
    };
    expect(res.result.content[0].type).toBe("text");
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.userId).toBe("u1"); // caller userId flowed through
    expect(payload.password).toBeNull(); // sanitizer redacted the secret field
    expect(payload.ok).toBe(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "mcp.tools_call", target: "get_thing", actor: "u1" }));
  });

  it("real catalog: scope tiers gate the mutate tools (read < deploy < admin) — Phase2a/2b", async () => {
    const { svc } = make(); // svc.tools defaults to the real MCP_TOOLS
    const names = async (scopes: string[]) =>
      ((await svc.handle(ctx(scopes), rpc("tools/list"))) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);

    const deployNames = await names(["deploy"]);
    // deploy token sees the deploy-tier lifecycle + swarm ops...
    expect(deployNames).toEqual(expect.arrayContaining(["deploy_application", "restart_application", "form_swarm", "join_swarm_node", "add_swarm_manager", "set_ingress_replicas", "fleet_app_action"]));
    // ...but NOT the admin-tier destructive tools
    expect(deployNames).not.toContain("dissolve_swarm");
    expect(deployNames).not.toContain("remove_application");

    const readNames = await names(["read"]);
    expect(readNames).toContain("list_applications"); // read tools still visible
    expect(readNames).not.toContain("restart_application"); // no mutate tools for a read-only token

    // a WRITE token sees the config tools but not deploy/admin tiers (write/deploy are independent siblings)
    const writeNames = await names(["write"]);
    expect(writeNames).toEqual(expect.arrayContaining(["set_env_var", "delete_env_var"]));
    expect(writeNames).not.toContain("restart_application"); // deploy tier
    expect(writeNames).not.toContain("remove_application"); // admin tier
    expect(deployNames).not.toContain("set_env_var"); // and a deploy token does NOT get the write-tier config tools

    const adminNames = await names(["admin"]);
    expect(adminNames).toEqual(expect.arrayContaining(["dissolve_swarm", "remove_application", "remove_swarm_manager", "leave_swarm_node", "set_env_var", "form_swarm", "restart_application"])); // admin sees everything

    // a deploy token calling an admin tool anyway is refused BEFORE execution
    const denied = (await svc.handle(ctx(["deploy"]), rpc("tools/call", { name: "remove_application", arguments: { id: "x", confirmName: "y" } }))) as { error: { code: number } };
    expect(denied.error.code).toBe(-32001);
    // and a read token calling a deploy tool is likewise refused
    const denied2 = (await svc.handle(ctx(["read"]), rpc("tools/call", { name: "restart_application", arguments: { id: "x" } }))) as { error: { code: number } };
    expect(denied2.error.code).toBe(-32001);
  });

  it("tools/call: a tool's sensitiveArgs are REDACTED from the audit log (secret values never persisted) (#F1)", async () => {
    const { svc, audit } = make();
    const execute = jest.fn().mockResolvedValue({ ok: true, key: "API_KEY" });
    svc.tools = [{ name: "set_env_var", description: "x", scope: "write", inputSchema: { type: "object", properties: {} }, sensitiveArgs: ["value"], execute }];
    await svc.handle(ctx(["write"]), rpc("tools/call", { name: "set_env_var", arguments: { id: "app1", key: "API_KEY", value: "sk_live_TOPSECRET" } }));
    // the tool still RECEIVES the real value...
    expect(execute).toHaveBeenCalledWith(expect.anything(), "u1", { id: "app1", key: "API_KEY", value: "sk_live_TOPSECRET" });
    // ...but the audit entry has it nulled, and the secret never appears anywhere in the audit args
    const auditCall = (audit.log as jest.Mock).mock.calls.find((c) => c[0].action === "mcp.tools_call");
    expect(auditCall![0].meta.args).toEqual({ id: "app1", key: "API_KEY", value: null });
    expect(JSON.stringify(auditCall![0])).not.toContain("sk_live_TOPSECRET");
  });

  it("tools/call: an executing tool that throws → isError content (not a JSON-RPC error) + audits", async () => {
    const { svc, audit } = make();
    svc.tools = [toolStub("boom", "read", async () => { throw new Error("kaboom"); })];
    const res = (await svc.handle(ctx(["read"]), rpc("tools/call", { name: "boom" }))) as {
      result: { content: { text: string }[]; isError: boolean };
    };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("kaboom");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ target: "boom", meta: expect.objectContaining({ outcome: "error" }) }));
  });
});

import { buildRequest, consentRows, COOLIFY_ACTIONS, register, slimSsh } from "./coolify";
import { Command } from "commander";

const CANARY = "CANARY-9f3a";

describe("tugra coolify", () => {
  it("maps every action to one GET route", () => {
    expect(buildRequest("status", undefined, { team: "t1" })).toEqual({ method: "GET", path: "/coolify-move/status?teamId=t1" });
    expect(buildRequest("takeover", "s1", {}).path).toBe("/coolify-inplace?serverId=s1");
    expect(buildRequest("consent", undefined, { team: "t1" }).path).toBe("/coolify-takeover/secrets/grants?teamId=t1");
    expect(buildRequest("campaigns", undefined, { team: "t1" }).path).toBe("/migration-campaigns?teamId=t1");
    expect(buildRequest("campaigns", undefined, { id: "c1" }).path).toBe("/migration-campaigns/c1");
    expect(buildRequest("cleanup", "s1", {}).path).toBe("/coolify-cleanup/servers/s1");
    expect(buildRequest("ssh", "s1", {}).path).toBe("/coolify-takeover/servers/s1/ssh/runs/latest");
    expect(buildRequest("ssh", "s1", { run: "r1" }).path).toBe("/coolify-takeover/servers/s1/ssh/runs/r1");
    expect(buildRequest("move", "p1", {}).path).toBe("/project-moves/project/p1");
    expect(buildRequest("move", undefined, { move: "m1" }).path).toBe("/project-moves/m1");
  });

  it("every request is a GET: the CLI cannot act on a server from here", () => {
    for (const a of COOLIFY_ACTIONS) expect(buildRequest(a, "x", { team: "t", id: undefined }).method).toBe("GET");
  });

  it("says what is missing", () => {
    expect(() => buildRequest("status", undefined, {})).toThrow(/--team/);
    expect(() => buildRequest("consent", undefined, {})).toThrow(/--team/);
    expect(() => buildRequest("campaigns", undefined, {})).toThrow(/--team/);
    expect(() => buildRequest("takeover", undefined, {})).toThrow(/server id/);
    expect(() => buildRequest("cleanup", undefined, {})).toThrow(/server id/);
    expect(() => buildRequest("ssh", undefined, {})).toThrow(/server id/);
    expect(() => buildRequest("move", undefined, {})).toThrow(/project id/);
  });

  it("encodes ids so a crafted one cannot change the route or add a query", () => {
    expect(buildRequest("takeover", "a/../b?x=1", {}).path).toBe("/coolify-inplace?serverId=a%2F..%2Fb%3Fx%3D1");
    expect(buildRequest("cleanup", "../../servers", {}).path).toBe("/coolify-cleanup/servers/..%2F..%2Fservers");
    expect(buildRequest("status", undefined, { team: "t&teamId=other" }).path).toBe("/coolify-move/status?teamId=t%26teamId%3Dother");
  });

  it("slimSsh drops the probe facts", () => {
    const v = { runId: "r1", finished: true, expiresAt: "x", inventoryServerId: "h", targets: [{ name: "w", state: "ONLINE", code: null, tugraServerId: "t", manualCommand: false, canRemove: true, probe: { machineIdHash: CANARY, sshHostKeyFp: CANARY } }] };
    expect(JSON.stringify(slimSsh(v))).not.toContain(CANARY);
    expect(slimSsh(null)).toBeNull();
  });

  it("consent shows only the secrets consent, for the asked server", () => {
    const grants = [{ id: "1", kind: "secrets", serverId: "a" }, { id: "2", kind: "ssh", serverId: "a" }, { id: "3", kind: "secrets", serverId: "b" }];
    expect(consentRows(grants).map((g) => g.id)).toEqual(["1", "3"]);
    expect(consentRows(grants, "b").map((g) => g.id)).toEqual(["3"]);
    expect(consentRows("nope")).toEqual([]);
  });

  it("registers one read-only command and refuses an unknown action", async () => {
    const program = new Command();
    program.exitOverride();
    register(program);
    const cmd = program.commands.find((c) => c.name() === "coolify");
    expect(cmd).toBeTruthy();
    await expect(program.parseAsync(["node", "tugra", "coolify", "wipe"])).rejects.toThrow(/unknown action/);
  });
});

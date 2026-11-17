import { ConflictException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { AgentDisconnectedException, AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { PatchService, patchTiming } from "./patch.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { DeployLogHub } from "../agent-gateway/deploy-log.hub";

const audit = { log: jest.fn() } as unknown as AuditService;

function makeLogs(): DeployLogHub {
  return { begin: jest.fn(), push: jest.fn(), finish: jest.fn(), subscribe: jest.fn().mockReturnValue(null) } as unknown as DeployLogHub;
}

function make(
  prisma: Partial<PrismaService>,
  access: Partial<TeamAccessService>,
  agentWs: Partial<AgentWsServer>,
  logs: DeployLogHub = makeLogs(),
) {
  return new PatchService(prisma as PrismaService, access as TeamAccessService, audit, agentWs as AgentWsServer, logs);
}

const server = { id: "s1", teamId: "t1" };

describe("PatchService", () => {
  it("forbids a viewer from checking updates", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("insufficient role")) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {}).checkUpdates("u1", "s1")).rejects.toThrow(/insufficient role/);
  });

  it("checkUpdates sends a 'patch' command and parses the output", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let cap = "";
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockImplementation((_s: string, _c: string, capability: string) => {
        cap = capability;
        return Promise.resolve({ exitCode: 0, output: "TUGRA_HOST_ENTERED\nTUGRA_MGR=apt\nTUGRA_UPGRADABLE\nListing...\ndocker-ce/noble 5:29.6.0 amd64 [upgradable from: 5:29.5.0]\n" });
      }),
    } as unknown as AgentWsServer;
    const r = await make(prisma, access, agentWs).checkUpdates("u1", "s1");
    expect(cap).toBe("patch");
    expect(r.count).toBe(1);
    expect(r.packages[0].name).toBe("docker-ce");
  });

  it("checkUpdates reports a phased package separately and keeps it out of the count", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const output = [
      "TUGRA_HOST_ENTERED",
      "TUGRA_MGR=apt",
      "TUGRA_UPGRADABLE",
      "Listing...",
      "snapd/noble-updates 2.78 amd64 [upgradable from: 2.76.3]",
      "TUGRA_PHASED_SIM",
      "The following upgrades have been deferred due to phasing:",
      "  snapd",
      "",
    ].join("\n");
    const agentWs = { isOnline: jest.fn().mockReturnValue(true), sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output }) } as unknown as AgentWsServer;
    const r = await make(prisma, access, agentWs).checkUpdates("u1", "s1");
    expect(r.count).toBe(0);
    expect(r.packages).toEqual([]);
    expect(r.phased).toEqual([{ name: "snapd", current: "2.76.3", candidate: "2.78" }]);
  });

  it("checkUpdates throws a typed AgentOfflineException (503) when the agent is offline — not a 500, and signs/audits nothing", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(false),
      sendCommand: jest.fn(),
    } as unknown as AgentWsServer;
    // audit.log is a module-level mock shared by every test (no clearMocks) — reset it so the
    // "never audited" assertion is about THIS call only.
    (audit.log as jest.Mock).mockClear();
    const err = await make(prisma, access, agentWs).checkUpdates("u1", "s1").catch((e: unknown) => e);
    // Clean 503 with a human message (not the masked 500), short-circuiting BEFORE signing + audit.
    expect(err).toBeInstanceOf(AgentOfflineException);
    expect((err as AgentOfflineException).getStatus()).toBe(503);
    expect((err as AgentOfflineException).message).toMatch(/offline/);
    expect(agentWs.sendCommand).not.toHaveBeenCalled();
    expect(audit.log as jest.Mock).not.toHaveBeenCalled();
  });

  it("checkUpdates SURFACES a host-exec failure (no TUGRA_HOST_ENTERED) as an error — never a false 'unsupported'", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      // the wrapper could not enter the host (e.g. rootless docker) → marker, non-zero, no host-entered
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 1, output: "TUGRA_HOST_UNAVAILABLE reason=userns\nTUGRA_HOST_EXEC_RC=1\n" }),
    } as unknown as AgentWsServer;
    await expect(make(prisma, access, agentWs).checkUpdates("u1", "s1")).rejects.toThrow(/host patching unavailable: userns/);
  });

  it("checkUpdatesBulk records a host-exec failure in the per-server error field (not a phantom up-to-date)", async () => {
    const prisma = { server: { findMany: jest.fn().mockResolvedValue([{ id: "s1", teamId: "t1" }]) } } as unknown as PrismaService;
    const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["servers:ops"])]])) } as unknown as TeamAccessService;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 1, output: "TUGRA_HOST_UNAVAILABLE reason=no-nsenter\n" }),
    } as unknown as AgentWsServer;
    const { results } = await make(prisma, access, agentWs).checkUpdatesBulk("u1", ["s1"]);
    expect(results[0]).toMatchObject({ serverId: "s1", online: true });
    expect(results[0].updates).toBeUndefined();
    expect(results[0].error).toMatch(/host patching unavailable: no-nsenter/);
  });

  it("upgradeAll streams via DeployLogHub and returns final output", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s, _c, _cap, _t, onChunk?: (c: string) => void) => {
        onChunk?.("TUGRA_HOST_ENTERED\nTUGRA_PATCH_MODE=unit\nTUGRA_PATCH_BEGIN\nReading package lists...\n");
        return Promise.resolve({ exitCode: 0, output: "TUGRA_HOST_ENTERED\nTUGRA_PATCH_MODE=unit\nTUGRA_PATCH_STARTED\nTUGRA_PATCH_BEGIN\nReading package lists...\nupgraded 3 packages\n\nTUGRA_PATCH_RC=0\n" });
      }),
    } as unknown as AgentWsServer;
    const logs = makeLogs();
    const r = await make(prisma, access, agentWs, logs).upgradeAll("u1", "s1");
    expect(r.output).toBe("Reading package lists...\nupgraded 3 packages\n");
    expect(r.exitCode).toBe(0);
    // The sent script is the HOST-EXEC wrapper (the real apt command is base64 inside it) — assert we run on
    // the host, not in the agent container.
    expect(agentWs.sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("--pid=host"), "patch", expect.any(Number), expect.any(Function));
    expect(agentWs.sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("nsenter -t 1"), "patch", expect.any(Number), expect.any(Function));
    expect(logs.begin).toHaveBeenCalledWith("s1");
    expect(logs.push).toHaveBeenCalledWith("s1", "Reading package lists...\n");
    expect(logs.finish).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "SUCCESS", exitCode: 0 }));
  });

  it("upgradeAll FAILS (not a false success) when the host was never entered, even on exit 0", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      // exit 0 but NO TUGRA_HOST_ENTERED (e.g. base64 missing → `sh -c ""` exits 0) — must NOT look successful
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "" }),
    } as unknown as AgentWsServer;
    const logs = makeLogs();
    await expect(make(prisma, access, agentWs, logs).upgradeAll("u1", "s1")).rejects.toThrow(/host patching unavailable/);
    expect(logs.finish).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "FAILED" }));
  });

  it("surfaces a name-mutex conflict as 'a patch is already running' (busy), not a generic error", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 125, output: 'docker: Error response: Conflict. The container name "/tugra-patch" is already in use.\n' }),
    } as unknown as AgentWsServer;
    await expect(make(prisma, access, agentWs).checkUpdates("u1", "s1")).rejects.toThrow(/already running/);
  });

  it("streamLogs subscribes to the server's patch log", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const logs = makeLogs();
    await make(prisma, access, {}, logs).streamLogs("u1", "s1");
    expect(logs.subscribe).toHaveBeenCalledWith("s1");
  });

  it("checkUpdatesBulk checks writable servers, skips non-writable, marks offline ones", async () => {
    const prisma = {
      server: { findMany: jest.fn().mockResolvedValue([{ id: "s1", teamId: "t1" }, { id: "s2", teamId: "t2" }, { id: "s3", teamId: "t1" }]) },
    } as unknown as PrismaService;
    // Only team t1 grants servers:ops → s2 (team t2) is skipped, not an error.
    const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["servers:ops"])]])) } as unknown as TeamAccessService;
    const agentWs = {
      isOnline: jest.fn().mockImplementation((id: string) => id === "s1"), // s3 is writable but its agent is offline
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "TUGRA_HOST_ENTERED\nTUGRA_MGR=apt\nTUGRA_UPGRADABLE\nListing...\ndocker-ce/noble 5:29.6.0 amd64 [upgradable from: 5:29.5.0]\n" }),
    } as unknown as AgentWsServer;

    const { results, skipped } = await make(prisma, access, agentWs).checkUpdatesBulk("u1", ["s1", "s2", "s3"]);

    expect(skipped).toEqual(["s2"]);
    expect(results.find((r) => r.serverId === "s1")).toMatchObject({ online: true });
    expect(results.find((r) => r.serverId === "s1")!.updates?.count).toBe(1);
    expect(results.find((r) => r.serverId === "s3")).toMatchObject({ online: false });
    expect(agentWs.sendCommand).toHaveBeenCalledTimes(1); // only the one writable + online server
  });

  it("upgradeAllBulk applies to writable online servers and skips cross-team ones", async () => {
    const prisma = {
      server: { findMany: jest.fn().mockResolvedValue([{ id: "s1", teamId: "t1" }, { id: "s2", teamId: "t2" }]) },
    } as unknown as PrismaService;
    const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["servers:ops"])]])) } as unknown as TeamAccessService;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "TUGRA_HOST_ENTERED\nTUGRA_PATCH_MODE=unit\nTUGRA_PATCH_BEGIN\ndone\n\nTUGRA_PATCH_RC=0\n" }),
    } as unknown as AgentWsServer;

    const { results, skipped } = await make(prisma, access, agentWs).upgradeAllBulk("u1", ["s1", "s2"]);

    expect(skipped).toEqual(["s2"]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ serverId: "s1", online: true, exitCode: 0 });
    expect(agentWs.sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("--pid=host"), "patch", expect.any(Number), expect.any(Function));
  });
});

// ── apply: host-side unit, re-attach across an engine restart ───────────────────────────────────────────────────
describe("PatchService apply (host-side unit)", () => {
  const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
  const HEAD = "TUGRA_HOST_ENTERED\nTUGRA_PATCH_MODE=unit\n";
  const BEGIN = "TUGRA_PATCH_BEGIN\n";

  /** The driver the host would run, recovered from the outer docker-run wrapper (two base64 layers). */
  function driver(script: string): string {
    const outer = /TUGRA_PATCH_B64='([A-Za-z0-9+/=]+)'/.exec(script);
    expect(outer).not.toBeNull();
    return Buffer.from(outer![1], "base64").toString("utf8");
  }
  const runId = (script: string) => /ID='([a-f0-9]+)'/.exec(driver(script))![1];
  const linesOf = (script: string) => Number(/^POS=(\d+)$/m.exec(driver(script))![1]);

  beforeEach(() => {
    patchTiming.retryPauseMs = 1;
    patchTiming.onlinePollMs = 1;
  });
  afterEach(() => jest.restoreAllMocks());

  it("returns the package manager's own exit code and output; audits BEFORE running", async () => {
    const order: string[] = [];
    (audit.log as jest.Mock).mockImplementation(async () => void order.push("audit"));
    const agentWs = {
      sendCommand: jest.fn().mockImplementation(async () => {
        order.push("send");
        return { exitCode: 0, output: `${HEAD}${BEGIN}E: held broken packages\n\nTUGRA_PATCH_RC=100\n` };
      }),
    } as unknown as AgentWsServer;
    const logs = makeLogs();
    const r = await make(prisma, access, agentWs, logs).upgradeOne("u1", "s1", "vim");
    expect(r).toEqual({ output: "E: held broken packages\n", exitCode: 100 });
    expect(order).toEqual(["audit", "send"]);
    expect(logs.finish).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "FAILED", exitCode: 100 }));
    (audit.log as jest.Mock).mockReset();
  });

  it("upgradePhased audits first, then runs the forced single-package install as the host-side unit", async () => {
    const order: string[] = [];
    (audit.log as jest.Mock).mockImplementation(async () => void order.push("audit"));
    let sent = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation(async (_s: string, script: string) => {
        order.push("send");
        sent = script;
        return { exitCode: 0, output: `${HEAD}${BEGIN}1 upgraded\n\nTUGRA_PATCH_RC=0\n` };
      }),
    } as unknown as AgentWsServer;
    const r = await make(prisma, access, agentWs, makeLogs()).upgradePhased("u1", "s1", "snapd");
    expect(r).toEqual({ output: "1 upgraded\n", exitCode: 0 });
    expect(order).toEqual(["audit", "send"]);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.patch.apply", target: "s1", meta: { pkg: "snapd", phased: true } }));
    const inner = Buffer.from(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > "\$D\/\$ID\.sh"/.exec(driver(sent))![1], "base64").toString("utf8");
    expect(inner).toContain("Always-Include-Phased-Updates=true install --only-upgrade -y snapd");
    (audit.log as jest.Mock).mockReset();
  });

  it("upgradePhased rejects a bad package name before auditing or sending", async () => {
    const agentWs = { sendCommand: jest.fn() } as unknown as AgentWsServer;
    await expect(make(prisma, access, agentWs, makeLogs()).upgradePhased("u1", "s1", "evil; rm -rf /")).rejects.toThrow(/invalid/);
    expect(agentWs.sendCommand).not.toHaveBeenCalled();
  });

  it("an apply that drops with the engine restart re-attaches to the SAME unit after the log lines it already has", async () => {
    const sent: string[] = [];
    let call = 0;
    const online = [false, false, true]; // the agent is down for two polls, then back
    const agentWs = {
      isOnline: jest.fn().mockImplementation(() => online.shift() ?? true),
      sendCommand: jest.fn().mockImplementation((_s: string, script: string, _c: string, _t: number, onChunk?: (c: string) => void) => {
        sent.push(script);
        if (++call === 1) {
          // docker-ce's postinst restarts dockerd: the helper and the agent die mid-stream, half a line in
          onChunk?.(`${HEAD}TUGRA_PATCH_STARTED\n${BEGIN}Unpacking docker-ce\nSetting up docker-`);
          return Promise.reject(new AgentDisconnectedException());
        }
        return Promise.resolve({ exitCode: 0, output: `${HEAD}${BEGIN}Setting up docker-ce\nDone\n\nTUGRA_PATCH_RC=0\n` });
      }),
    } as unknown as AgentWsServer;
    const logs = makeLogs();
    const r = await make(prisma, access, agentWs, logs).upgradeAll("u1", "s1");

    expect(sent).toHaveLength(2);
    expect(runId(sent[1])).toBe(runId(sent[0])); // same unit — never a second apply
    expect(linesOf(sent[0])).toBe(0);
    expect(linesOf(sent[1])).toBe(1); // the partial line is re-read, not lost
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("Unpacking docker-ce\nSetting up docker-ce\nDone\n"); // seamless, nothing duplicated
    // the live stream saw each byte once, in order
    const pushed = (logs.push as jest.Mock).mock.calls.map((c) => c[1]).join("");
    expect(pushed).toBe("Unpacking docker-ce\nSetting up docker-ce\nDone\n");
    expect(logs.finish).toHaveBeenCalledTimes(1);
    expect(logs.finish).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "SUCCESS", exitCode: 0 }));
  });

  it("reads the exit code from the live chunks when the agent's final output is capped at 64 KiB", async () => {
    // exec.go: Result.Output keeps the first 64 KiB then "\n…(truncated)" — the RC marker is past the cap.
    const body = "Setting up pkg ...\n".repeat(5000); // ~95 KB
    const full = `${HEAD}${BEGIN}${body}\nTUGRA_PATCH_RC=0\n`;
    const capped = full.slice(0, 65536) + "\n…(truncated)";
    let attaches = 0;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockImplementation((_s: string, _sc: string, _c: string, _t: number, onChunk?: (c: string) => void) => {
        if (++attaches > 3) return Promise.reject(new Error("re-attach loop")); // a broken parse would spin here
        for (let i = 0; i < full.length; i += 4096) onChunk?.(full.slice(i, i + 4096));
        return Promise.resolve({ exitCode: 0, output: capped });
      }),
    } as unknown as AgentWsServer;
    const logs = makeLogs();
    const r = await make(prisma, access, agentWs, logs).upgradeAll("u1", "s1");
    expect(agentWs.sendCommand).toHaveBeenCalledTimes(1); // no pointless re-attach loop
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe(body.slice(-65536)); // the tail the caller gets, intact
    expect(r.output).not.toContain("truncated");
    expect((logs.push as jest.Mock).mock.calls.map((c) => c[1]).join("")).toBe(body); // the live stream is whole
    expect(logs.finish).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "SUCCESS", exitCode: 0 }));
  });

  it("resumes by log lines: non-UTF-8 text in the log cannot shift the resume point", async () => {
    const sent: string[] = [];
    let call = 0;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockImplementation((_s: string, script: string, _c: string, _t: number, onChunk?: (c: string) => void) => {
        sent.push(script);
        if (++call === 1) {
          // Two split halves of a multibyte character reach the hub as U+FFFD each (3 bytes apiece, 1 byte on the host).
          onChunk?.(`${HEAD}${BEGIN}caf\uFFFD\uFFFD done\nsecond\nthird-par`);
          return Promise.reject(new AgentDisconnectedException());
        }
        return Promise.resolve({ exitCode: 0, output: `${HEAD}${BEGIN}third-part\n\nTUGRA_PATCH_RC=0\n` });
      }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).upgradeAll("u1", "s1");
    expect(linesOf(sent[1])).toBe(2); // two complete lines, whatever their bytes
  });

  it("re-attaches when the helper ends before the unit does (no exit code yet)", async () => {
    let call = 0;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockImplementation(() =>
        Promise.resolve(++call === 1 ? { exitCode: 137, output: `${HEAD}${BEGIN}partial\n` } : { exitCode: 0, output: `${HEAD}${BEGIN}\nTUGRA_PATCH_RC=0\n` }),
      ),
    } as unknown as AgentWsServer;
    const r = await make(prisma, access, agentWs).upgradeAll("u1", "s1");
    expect(call).toBe(2);
    expect(r).toEqual({ output: "partial\n", exitCode: 0 });
  });

  it("waits out a leftover helper holding the name after a restart, then continues", async () => {
    let call = 0;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) return Promise.reject(new AgentDisconnectedException());
        if (call === 2) return Promise.resolve({ exitCode: 125, output: 'Conflict. The container name "/tugra-patch" is already in use' });
        return Promise.resolve({ exitCode: 0, output: `${HEAD}${BEGIN}ok\n\nTUGRA_PATCH_RC=0\n` });
      }),
    } as unknown as AgentWsServer;
    expect((await make(prisma, access, agentWs).upgradeAll("u1", "s1")).exitCode).toBe(0);
    expect(call).toBe(3);
  });

  it("gives up with a clear message (the unit keeps running) when the agent never comes back", async () => {
    const t0 = Date.now();
    let n = 0;
    jest.spyOn(Date, "now").mockImplementation(() => (++n <= 2 ? t0 : t0 + 10_000_000));
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(false),
      sendCommand: jest.fn().mockRejectedValue(new AgentDisconnectedException()),
    } as unknown as AgentWsServer;
    const logs = makeLogs();
    await expect(make(prisma, access, agentWs, logs).upgradeAll("u1", "s1")).rejects.toThrow(/disconnected/);
    expect(logs.finish).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "FAILED" }));
  });

  it("does NOT re-attach an inline (no-systemd) run that drops — a re-run would start the upgrade again", async () => {
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockImplementation((_s: string, _sc: string, _c: string, _t: number, onChunk?: (c: string) => void) => {
        onChunk?.("TUGRA_HOST_ENTERED\nTUGRA_PATCH_MODE=inline\nTUGRA_PATCH_BEGIN\nworking\n");
        return Promise.reject(new AgentDisconnectedException());
      }),
    } as unknown as AgentWsServer;
    await expect(make(prisma, access, agentWs).upgradeAll("u1", "s1")).rejects.toThrow(/disconnected/);
    expect(agentWs.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("a container-engine refusal on a host without systemd is a 409 with the packages named", async () => {
    const agentWs = {
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 1, output: "TUGRA_HOST_ENTERED\nTUGRA_PATCH_MODE=inline\nTUGRA_PATCH_ENGINE_BLOCKED=docker-ce,containerd.io\n" }),
    } as unknown as AgentWsServer;
    const err = await make(prisma, access, agentWs).upgradeAll("u1", "s1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/docker-ce, containerd\.io/);
    expect((err as Error).message).toMatch(/no systemd/);
  });

  it("another patch unit already running is the 'already running' 503, never a second apply", async () => {
    const agentWs = {
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 1, output: `${HEAD}TUGRA_PATCH_BUSY\n` }),
    } as unknown as AgentWsServer;
    const err = await make(prisma, access, agentWs).upgradeAll("u1", "s1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as Error).message).toMatch(/already running/);
  });

  it("a unit that vanished without an exit code is a failure, not a success", async () => {
    const agentWs = {
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: `${HEAD}${BEGIN}x\n\nTUGRA_PATCH_RC=-1\n` }),
    } as unknown as AgentWsServer;
    const r = await make(prisma, access, agentWs).upgradeAll("u1", "s1");
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/without reporting an exit code/);
  });

  it("the fleet apply follows the unit too (no live stream) and reports the exit code", async () => {
    const p = { server: { findMany: jest.fn().mockResolvedValue([{ id: "s1", teamId: "t1" }]) } } as unknown as PrismaService;
    const a = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["servers:ops"])]])) } as unknown as TeamAccessService;
    let call = 0;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockImplementation(() => (++call === 1 ? Promise.reject(new AgentDisconnectedException()) : Promise.resolve({ exitCode: 0, output: `${HEAD}${BEGIN}\nTUGRA_PATCH_RC=7\n` }))),
    } as unknown as AgentWsServer;
    const logs = makeLogs();
    const { results } = await make(p, a, agentWs, logs).upgradeAllBulk("u1", ["s1"]);
    expect(results[0]).toMatchObject({ serverId: "s1", online: true, exitCode: 7 });
    expect(logs.begin).not.toHaveBeenCalled();
  });
});

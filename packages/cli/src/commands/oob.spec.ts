import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { formatCandidates, formatOobStatus, parsePowerAction, register, runOobPower, type OobDeps } from "./oob";
import { register as registerResources } from "./resources";
import { setProfile } from "../config";
import type { OobStatusShape } from "../client";

describe("parsePowerAction", () => {
  it("maps the words people type; reboot is the HARD reset", () => {
    expect(parsePowerAction("on")).toBe("power_on");
    expect(parsePowerAction("OFF")).toBe("power_off");
    expect(parsePowerAction("reboot")).toBe("reboot");
    expect(parsePowerAction("shutdown")).toBe("shutdown");
    expect(parsePowerAction("power_off")).toBe("power_off");
  });
  it("refuses anything else with the list of valid words", () => {
    expect(() => parsePowerAction("format")).toThrow(/use on, off \(hard\), reboot \(hard reset\) or shutdown/);
    expect(() => parsePowerAction("")).toThrow(/unknown power action/);
  });
});

describe("runOobPower", () => {
  const res = { ok: true, action: "reboot", providerAction: { id: "1", status: "running", command: "reset" } } as never;
  function make(over: Partial<OobDeps> = {}) {
    const client = { getServer: jest.fn().mockResolvedValue({ id: "s1", name: "web-1" }), oobPower: jest.fn().mockResolvedValue(res) };
    const ask = jest.fn().mockResolvedValue("web-1");
    const deps: OobDeps = { client, ask, interactive: true, ...over };
    return { deps, client, ask };
  }

  it("power on needs no name and no lookup", async () => {
    const { deps, client, ask } = make();
    await runOobPower(deps, "s1", "on", {});
    expect(client.oobPower).toHaveBeenCalledWith("s1", { action: "power_on" });
    expect(client.getServer).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it.each(["off", "reboot", "shutdown"])("%s asks for the server name and sends it as the confirmation", async (word) => {
    const { deps, client, ask } = make();
    await runOobPower(deps, "s1", word, {});
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("web-1"));
    expect(client.oobPower).toHaveBeenCalledWith("s1", { action: parsePowerAction(word), confirmName: "web-1" });
  });

  it("a wrong typed name sends nothing", async () => {
    const { deps, client } = make({ ask: jest.fn().mockResolvedValue("web") });
    await expect(runOobPower(deps, "s1", "reboot", {})).rejects.toThrow(/did not match/);
    expect(client.oobPower).not.toHaveBeenCalled();
  });

  it("without --yes and without a terminal it refuses (nobody to confirm)", async () => {
    const { deps, client, ask } = make({ interactive: false });
    await expect(runOobPower(deps, "s1", "off", {})).rejects.toThrow(/refusing to off without confirmation/);
    expect(ask).not.toHaveBeenCalled();
    expect(client.oobPower).not.toHaveBeenCalled();
  });

  it("--yes confirms without asking, even without a terminal", async () => {
    const { deps, client, ask } = make({ interactive: false });
    await runOobPower(deps, "s1", "reboot", { yes: true });
    expect(ask).not.toHaveBeenCalled();
    expect(client.oobPower).toHaveBeenCalledWith("s1", { action: "reboot", confirmName: "web-1" });
  });

  it("an unknown word fails before the hub is contacted", async () => {
    const { deps, client } = make();
    await expect(runOobPower(deps, "s1", "nuke", { yes: true })).rejects.toThrow(/unknown power action/);
    expect(client.getServer).not.toHaveBeenCalled();
  });
});

describe("formatOobStatus / formatCandidates", () => {
  const base: OobStatusShape = { linked: true, provider: "hetzner", providerServerId: "42", manual: true, supported: true, credentialName: "prod", credentialMissing: false, canManage: true, canOps: true, state: { providerServerId: "42", name: "web-1", status: "off", locked: false, rescueEnabled: true, publicIpv4: "203.0.113.10", publicIpv6: null }, stateError: null };
  it("not linked, and linked with a deleted credential", () => {
    expect(formatOobStatus({ ...base, linked: false, state: null })[0]).toMatch(/not linked/);
    expect(formatOobStatus({ ...base, linked: false, credentialMissing: true, state: null })[0]).toMatch(/credential was deleted/);
  });
  it("linked: power, rescue and address; a state error is shown without hiding the link", () => {
    const lines = formatOobStatus(base);
    expect(lines.join("\n")).toContain("power: off");
    expect(lines.join("\n")).toContain("rescue mode: armed");
    expect(lines.join("\n")).toContain("linked by hand");
    const err = formatOobStatus({ ...base, state: null, stateError: "hetzner is rate limiting requests" });
    expect(err.join("\n")).toContain("could not read the cloud server: hetzner is rate limiting requests");
  });
  it("candidates table marks the IP match and taken ones", () => {
    const t = formatCandidates([{ providerServerId: "42", name: "web-1", status: "running", publicIpv4: "203.0.113.10", matchesIp: true, taken: false }, { providerServerId: "77", name: "db-1", status: "off", publicIpv4: null, matchesIp: false, taken: true }]);
    expect(t).toMatch(/42\s+web-1\s+running\s+203\.0\.113\.10\s+yes/);
    expect(t).toMatch(/77\s+db-1\s+off\s+taken|77\s+db-1\s+off\s+.*taken/);
  });
});

describe("tugra servers oob-* (wired to the REST routes)", () => {
  let dir: string;
  let out: string[];
  const origFetch = globalThis.fetch;
  let calls: { method: string; url: string; body: unknown; auth: string | null }[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugra-cli-"));
    process.env.XDG_CONFIG_HOME = dir;
    setProfile("default", { hub: "https://h", token: "tugra_pat_x" });
    out = [];
    calls = [];
    jest.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    globalThis.fetch = jest.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const method = init?.method ?? "GET";
      const u = String(url).replace("https://h/api/v1", "");
      calls.push({ method, url: u, body: init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.authorization ?? null });
      let body: unknown = {};
      if (u === "/servers/s1") body = { id: "s1", name: "web-1" };
      else if (u === "/servers/s1/oob") body = { linked: true, provider: "hetzner", providerServerId: "42", manual: false, supported: true, credentialName: "prod", credentialMissing: false, canManage: true, canOps: true, state: { providerServerId: "42", name: "web-1", status: "running", locked: false, rescueEnabled: false, publicIpv4: "203.0.113.10", publicIpv6: null }, stateError: null };
      else if (u === "/servers/s1/oob/power") body = { ok: true, action: (JSON.parse(init!.body!) as { action: string }).action, providerAction: { id: "9", status: "running", command: "reset" } };
      else if (u === "/servers/s1/oob/rescue" && method === "POST") body = { ok: true, action: "enable_rescue", providerAction: { id: "9", status: "running", command: "enable_rescue" }, rootPassword: "ROOT-PW-123", expiresInMinutes: 60 };
      else if (u === "/servers/s1/oob/rescue") body = { ok: true, action: "disable_rescue", providerAction: { id: "9", status: "running", command: "disable_rescue" } };
      else if (u === "/servers/s1/oob/console") body = { ok: true, action: "console", providerAction: { id: "9", status: "running", command: "request_console" }, wssUrl: "wss://console.example/?t=x", password: "VNC-PW-456", validForSeconds: 60 };
      else if (u.startsWith("/servers/s1/oob/candidates")) body = [{ providerServerId: "42", name: "web-1", status: "running", publicIpv4: "203.0.113.10", matchesIp: true, taken: false }];
      else if (u === "/servers/s1/oob/link") body = { linked: true, provider: "hetzner", providerServerId: "42", manual: true, supported: true, credentialName: "prod", credentialMissing: false, canManage: true, canOps: true, state: null, stateError: null };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
    globalThis.fetch = origFetch;
    jest.restoreAllMocks();
  });

  function program() {
    const p = new Command();
    registerResources(p);
    register(p);
    return p;
  }
  const reqs = () => calls.map((c) => `${c.method} ${c.url}`);

  it("oob-status reads the link and prints the power state", async () => {
    await program().parseAsync(["node", "tugra", "servers", "oob-status", "s1"]);
    expect(reqs()).toEqual(["GET /servers/s1/oob"]);
    expect(calls[0].auth).toBe("Bearer tugra_pat_x");
    expect(out.join("")).toContain("power: running");
  });

  it("oob-power off --yes reads the name, then POSTs the hard action with it; on needs neither", async () => {
    await program().parseAsync(["node", "tugra", "servers", "oob-power", "s1", "off", "--yes"]);
    expect(reqs()).toEqual(["GET /servers/s1", "POST /servers/s1/oob/power"]);
    expect(calls[1].body).toEqual({ action: "power_off", confirmName: "web-1" });
    calls.length = 0;
    await program().parseAsync(["node", "tugra", "servers", "oob-power", "s1", "on"]);
    expect(reqs()).toEqual(["POST /servers/s1/oob/power"]);
    expect(calls[0].body).toEqual({ action: "power_on" });
  });

  it("without --yes and without a terminal nothing is sent", async () => {
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(program().parseAsync(["node", "tugra", "servers", "oob-power", "s1", "reboot"])).rejects.toThrow(/refusing to reboot without confirmation/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
    }
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("oob-rescue enable prints the one-time password once; disable is a DELETE", async () => {
    await program().parseAsync(["node", "tugra", "servers", "oob-rescue", "s1", "enable"]);
    expect(reqs()).toEqual(["POST /servers/s1/oob/rescue"]);
    expect(out.join("")).toContain("ROOT-PW-123");
    expect(out.join("").match(/ROOT-PW-123/g)).toHaveLength(1);
    await program().parseAsync(["node", "tugra", "servers", "oob-rescue", "s1", "disable"]);
    expect(reqs()[1]).toBe("DELETE /servers/s1/oob/rescue");
    await expect(program().parseAsync(["node", "tugra", "servers", "oob-rescue", "s1", "maybe"])).rejects.toThrow(/enable.*disable/);
  });

  it("oob-console prints the url and password once", async () => {
    await program().parseAsync(["node", "tugra", "servers", "oob-console", "s1"]);
    expect(reqs()).toEqual(["POST /servers/s1/oob/console"]);
    expect(out.join("")).toContain("VNC-PW-456");
  });

  it("oob-link lists candidates with only --credential, links with --cloud-server", async () => {
    await program().parseAsync(["node", "tugra", "servers", "oob-link", "s1", "--credential", "cc1"]);
    expect(reqs()).toEqual(["GET /servers/s1/oob/candidates?cloudCredentialId=cc1"]);
    expect(out.join("")).toContain("web-1");
    await program().parseAsync(["node", "tugra", "servers", "oob-link", "s1", "--credential", "cc1", "--cloud-server", "42", "--confirm-name", "web-1"]);
    expect(calls[1]).toMatchObject({ method: "PUT", url: "/servers/s1/oob/link", body: { cloudCredentialId: "cc1", providerServerId: "42", confirmProviderName: "web-1" } });
    await program().parseAsync(["node", "tugra", "servers", "oob-unlink", "s1"]);
    expect(reqs()[2]).toBe("DELETE /servers/s1/oob/link");
  });
});

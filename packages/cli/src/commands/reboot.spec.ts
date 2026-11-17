import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { formatRebootStatus, impactLines, parseAt, register, runReboot, type RebootDeps } from "./reboot";
import { register as registerResources } from "./resources";
import { setProfile } from "../config";
import type { RebootStatusShape, RebootViewShape } from "../client";

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const h = 3_600_000;

describe("parseAt", () => {
  it("reads an ISO instant, with a zone or as local time, and relative +30m / +2h / +1d", () => {
    expect(parseAt("2026-12-01T03:00:00Z", NOW)).toBe("2026-12-01T03:00:00.000Z");
    expect(parseAt("2026-12-01T06:00:00+03:00", NOW)).toBe("2026-12-01T03:00:00.000Z");
    expect(parseAt("2026-12-01 03:00", NOW)).toBe(new Date(2026, 11, 1, 3, 0).toISOString()); // this machine's local time
    expect(parseAt("+30m", NOW)).toBe(new Date(NOW + 30 * 60_000).toISOString());
    expect(parseAt("+2h", NOW)).toBe(new Date(NOW + 2 * h).toISOString());
    expect(parseAt("+1d", NOW)).toBe(new Date(NOW + 24 * h).toISOString());
  });
  it("refuses garbage, the past, under a minute, and more than 7 days", () => {
    expect(() => parseAt("tomorrow", NOW)).toThrow(/cannot read --at/);
    expect(() => parseAt("", NOW)).toThrow(/cannot read --at/);
    expect(() => parseAt("2026-11-27T11:00:00Z", NOW)).toThrow(/at least a minute/);
    expect(() => parseAt("+0m", NOW)).toThrow(/at least a minute/);
    expect(() => parseAt("2026-12-10T00:00:00Z", NOW)).toThrow(/within the next 7 days/);
    expect(() => parseAt("+8d", NOW)).toThrow(/within the next 7 days/);
  });
});

describe("impactLines", () => {
  it("counts, hub warning and offline agent", () => {
    expect(impactLines({ containers: 7, domains: 3, hostsHub: false, agentOnline: true })).toEqual(["7 containers and 3 domains will be briefly unavailable."]);
    const l = impactLines({ containers: 1, domains: 0, hostsHub: true, agentOnline: false });
    expect(l).toHaveLength(3);
    expect(l[1]).toMatch(/hub.*1 to 3 minutes/);
    expect(l[2]).toMatch(/agent is offline/);
  });
});

describe("runReboot", () => {
  const view = { id: "rb1", mode: "now", state: "REBOOTING" } as unknown as RebootViewShape;
  function make(over: Partial<RebootDeps> = {}) {
    const client = {
      getServer: jest.fn().mockResolvedValue({ id: "s1", name: "prod-1" }),
      getServerRebootPreview: jest.fn().mockResolvedValue({ containers: 7, domains: 3, hostsHub: false, agentOnline: true }),
      requestServerReboot: jest.fn().mockResolvedValue(view),
    };
    const out: string[] = [];
    const ask = jest.fn().mockResolvedValue("prod-1");
    const deps: RebootDeps = { client, ask, interactive: true, out: (l) => out.push(l), ...over };
    return { deps, client, out, ask };
  }

  it("asks for the server's name, prints the impact first, then reboots with that name", async () => {
    const { deps, client, out, ask } = make();
    const r = await runReboot(deps, "s1", {});
    expect(out).toEqual(["7 containers and 3 domains will be briefly unavailable."]);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("prod-1"));
    expect(client.requestServerReboot).toHaveBeenCalledWith("s1", { mode: "now", confirmName: "prod-1" });
    expect(r).toBe(view);
  });

  it("a wrong typed name reboots nothing", async () => {
    const { deps, client } = make({ ask: jest.fn().mockResolvedValue("prod") });
    await expect(runReboot(deps, "s1", {})).rejects.toThrow(/did not match/);
    expect(client.requestServerReboot).not.toHaveBeenCalled();
  });

  it("without --yes and without a terminal it refuses (nobody to confirm)", async () => {
    const { deps, client, ask } = make({ interactive: false });
    await expect(runReboot(deps, "s1", {})).rejects.toThrow(/refusing to reboot without confirmation/);
    expect(ask).not.toHaveBeenCalled();
    expect(client.requestServerReboot).not.toHaveBeenCalled();
  });

  it("--yes confirms without asking (and works without a terminal)", async () => {
    const { deps, client, ask } = make({ interactive: false });
    await runReboot(deps, "s1", { yes: true });
    expect(ask).not.toHaveBeenCalled();
    expect(client.requestServerReboot).toHaveBeenCalledWith("s1", { mode: "now", confirmName: "prod-1" });
  });

  it("--at schedules, with the UTC instant", async () => {
    const { deps, client } = make();
    await runReboot(deps, "s1", { yes: true, at: "2026-11-28T03:00:00Z" }, NOW);
    expect(client.requestServerReboot).toHaveBeenCalledWith("s1", { mode: "scheduled", at: "2026-11-28T03:00:00.000Z", confirmName: "prod-1" });
  });

  it("a bad --at fails before anything is asked of the hub", async () => {
    const { deps, client } = make();
    await expect(runReboot(deps, "s1", { yes: true, at: "nonsense" }, NOW)).rejects.toThrow(/cannot read --at/);
    expect(client.getServer).not.toHaveBeenCalled();
    expect(client.requestServerReboot).not.toHaveBeenCalled();
  });

  it("--json keeps the impact text off stdout", async () => {
    const { deps, out } = make();
    await runReboot(deps, "s1", { yes: true, json: true });
    expect(out).toEqual([]);
  });
});

describe("formatRebootStatus", () => {
  const report = {
    rebooted: true,
    docker: "active",
    rebootRequired: "cleared",
    containers: [
      { name: "web", image: "n", restartPolicy: "always", verdict: "ok" },
      { name: "db", image: "p", restartPolicy: "always", verdict: "missing", detail: "exited" },
    ],
    domains: [{ host: "a.example.com", verdict: "not_answering", status: 502 }],
    summary: { containersOk: 1, containersExpected: 2, domainsOk: 0, domainsExpected: 1 },
  };
  it("nothing yet", () => {
    expect(formatRebootStatus({ active: null, last: null })).toEqual(["no reboot in progress or scheduled", "", "no finished reboot yet"]);
  });
  it("a live reboot and the last report, listing only what did not come back", () => {
    const s = {
      active: { id: "a", mode: "scheduled", state: "SCHEDULED", result: null, scheduledAt: "2026-11-28T03:00:00.000Z", snapshot: null, report: null },
      last: { id: "l", mode: "now", state: "DONE", result: "degraded", verifiedAt: "2026-11-27T12:10:00.000Z", report },
    } as unknown as RebootStatusShape;
    const lines = formatRebootStatus(s);
    expect(lines[0]).toBe("state: scheduled (for 2026-11-28T03:00:00.000Z)");
    expect(lines).toContain("last reboot: degraded (verified 2026-11-27T12:10:00.000Z)");
    expect(lines).toContain("  containers 1/2 running, domains 0/1 answering, reboot-required flag cleared");
    expect(lines).toContain("  container db: missing (exited)");
    expect(lines).toContain("  domain a.example.com: not_answering (502)");
    expect(lines.join("\n")).not.toContain("container web");
  });
});

describe("tugra servers reboot (wired to the REST routes)", () => {
  let dir: string;
  let out: string[];
  const origFetch = globalThis.fetch;
  let calls: { method: string; url: string; body: unknown }[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugra-cli-"));
    process.env.XDG_CONFIG_HOME = dir;
    setProfile("default", { hub: "https://h", token: "tugra_pat_x" });
    out = [];
    calls = [];
    jest.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    globalThis.fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      const u = String(url);
      let body: unknown = {};
      if (u.endsWith("/servers/s1") && method === "GET") body = { id: "s1", name: "prod-1" };
      else if (u.endsWith("/reboot/preview")) body = { containers: 2, domains: 1, hostsHub: false, agentOnline: true };
      else if (u.endsWith("/reboot") && method === "POST") body = { id: "rb1", mode: (JSON.parse(init!.body!) as { mode: string }).mode, state: "REBOOTING", scheduledAt: null };
      else if (u.endsWith("/reboot") && method === "DELETE") body = { id: "rb1", state: "DONE", result: "cancelled" };
      else if (u.endsWith("/reboot")) body = { active: { id: "rb1", mode: "now", state: "VERIFYING", snapshot: { containers: 2, domains: 1, hostsHub: false } }, last: null };
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

  it("`servers reboot <id> --yes` reads the name, previews, then POSTs mode=now with that name", async () => {
    await program().parseAsync(["node", "tugra", "servers", "reboot", "s1", "--yes"]);
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://h/api/v1", "")}`)).toEqual(["GET /servers/s1", "GET /servers/s1/reboot/preview", "POST /servers/s1/reboot"]);
    expect(calls[2].body).toEqual({ mode: "now", confirmName: "prod-1" });
    expect(out.join("")).toContain("2 containers and 1 domains will be briefly unavailable.");
    expect(out.join("")).toContain("rebooting in a few seconds");
  });

  it("the singular alias `server` works, and --at schedules", async () => {
    await program().parseAsync(["node", "tugra", "server", "reboot", "s1", "--yes", "--at", "+2h"]);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ mode: "scheduled", confirmName: "prod-1" });
    expect(typeof (post.body as { at: string }).at).toBe("string");
  });

  it("without --yes and without a terminal nothing is POSTed", async () => {
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(program().parseAsync(["node", "tugra", "servers", "reboot", "s1"])).rejects.toThrow(/refusing to reboot without confirmation/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
    }
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("`servers reboot-status <id>` and `reboot-cancel <id>`", async () => {
    await program().parseAsync(["node", "tugra", "servers", "reboot-status", "s1"]);
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://h/api/v1/servers/s1/reboot" });
    expect(out.join("")).toContain("state: verifying");
    await program().parseAsync(["node", "tugra", "servers", "reboot-cancel", "s1"]);
    expect(calls[1]).toMatchObject({ method: "DELETE", url: "https://h/api/v1/servers/s1/reboot" });
  });
});

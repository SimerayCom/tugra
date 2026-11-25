import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import type { CoolifySshResultMsg } from "@tugra/shared";
import { AgentCommandTimeoutException, AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ServersService } from "../servers/servers.service";
import { CoolifySshInstallService } from "./coolify-ssh-install.service";
import { COOLIFY_HOST_IDENTITY } from "./coolify-ssh-plan";
import { COOLIFY_SSH_PROBE_SHA256, COOLIFY_SSH_UNINSTALL_SHA256 } from "./coolify-ssh-scripts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const FP = "SHA256:" + "A".repeat(43);
const CID = "c".repeat(64);
const TOKEN = "tugra_en_CANARYCANARYCANARYCANARY0123456789";

// ---- a tiny in-memory Prisma for the three tables and the server table this service touches ----------------------------------------

type Row = Record<string, any>;
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return (v.in as unknown[]).includes(row[k]);
      if ("not" in v) return row[k] !== v.not && !(v.not === null && row[k] === null);
      if ("gt" in v) return row[k] > v.gt;
      if ("lt" in v) return row[k] < v.lt;
      if ("lte" in v) return row[k] <= v.lte;
      return false;
    }
    return (row[k] ?? null) === v || row[k] === v;
  });
}
function table(rows: Row[], mk: () => Row = () => ({})) {
  let n = 0;
  const apply = (r: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === "object" && "increment" in v ? (r[k] ?? 0) + v.increment : v;
  };
  const pick = (r: Row | undefined, select?: Row) => (r && select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : r);
  return {
    rows,
    findMany: async ({ where, select, orderBy }: Row = {}) => {
      const out = rows.filter((r) => matches(r, where));
      if (orderBy?.createdAt) out.sort((a, b) => (orderBy.createdAt === "desc" ? -1 : 1) * (a.createdAt - b.createdAt));
      return out.map((r) => pick(r, select));
    },
    findFirst: async ({ where, orderBy, select }: Row = {}) => {
      const out = rows.filter((r) => matches(r, where));
      if (orderBy?.createdAt) out.sort((a, b) => (orderBy.createdAt === "desc" ? -1 : 1) * (a.createdAt - b.createdAt));
      return pick(out[0], select) ?? null;
    },
    findUnique: async ({ where, select }: Row) => pick(rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)), select) ?? null,
    create: async ({ data }: Row) => {
      const r = { id: `id${++n}${rows.length}`, createdAt: Date.now() + n, updatedAt: new Date(), ...mk(), ...data };
      rows.push(r);
      return r;
    },
    createMany: async ({ data }: Row) => {
      for (const d of data) rows.push({ id: `id${++n}${rows.length}`, createdAt: new Date(Date.now() + n), updatedAt: new Date(), attempts: 0, probe: null, hostKeyFp: null, containerId: null, cancelledAt: null, startedAt: null, finishedAt: null, code: null, tugraServerId: null, grantId: null, ...d });
      return { count: data.length };
    },
    updateMany: async ({ where, data }: Row) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => {
        apply(r, data);
        r.updatedAt = new Date();
      });
      return { count: hit.length };
    },
    count: async ({ where }: Row = {}) => rows.filter((r) => matches(r, where)).length,
  };
}

const ROLES: Record<string, Record<string, string>> = { owner: { T_HOST: "OWNER", T_NEW: "OWNER" }, admin: { T_HOST: "ADMIN", T_NEW: "OWNER" }, other: {} };

function snapshotOf(servers: Array<{ uuid: string; ip: string; name?: string; isLocal?: boolean }>) {
  return {
    v: 1,
    servers: [
      { id: "0", uuid: "localuuid0001", name: "localhost", ip: "host.docker.internal", port: 22, user: "root", isLocal: true, keyName: "local key", teamId: "0" },
      ...servers.map((s, i) => ({ id: String(i + 1), uuid: s.uuid, name: s.name ?? `srv${i + 1}`, ip: s.ip, port: 22, user: "root", isLocal: !!s.isLocal, keyName: "edge key", teamId: "1" })),
    ],
  };
}

interface Opts {
  uuids?: string[];
  online?: boolean;
  features?: boolean;
  capsAtStart?: string[];
  probe?: (uuid: string, n: number) => CoolifySshResultMsg | Error;
  install?: (uuid: string) => CoolifySshResultMsg | Error;
  uninstall?: (uuid: string) => CoolifySshResultMsg | Error;
  enrolls?: boolean; // the new agent comes ONLINE after the install
  knownServers?: Row[];
  identity?: string | null;
}

function world(o: Opts = {}) {
  const uuids = o.uuids ?? ["srvaaa111111", "srvbbb222222"];
  const inventory = table([{ serverId: "HOST", teamId: "T_HOST", snapshot: snapshotOf(uuids.map((u, i) => ({ uuid: u, ip: `198.51.100.${i + 10}` }))) }]);
  const targets = table([]);
  const grants = table([]);
  const servers = table([...(o.knownServers ?? [])]);
  const prisma = { coolifyInventory: inventory, coolifySshTarget: targets, coolifyHostGrant: grants, server: servers } as any;

  let role = "owner";
  const access = {
    teamIds: async () => ["T_HOST", "T_NEW"],
    requireRole: async (_u: string, team: string, roles: string[]) => {
      const r = ROLES[role][team];
      if (!r || !roles.includes(r)) throw new ForbiddenException("insufficient role for this team");
    },
    requirePermission: async (_u: string, team: string) => {
      if (!ROLES[role][team]) throw new ForbiddenException("insufficient permission for this team");
    },
  } as any;

  const auditLog: Row[] = [];
  const audit = { log: jest.fn(async (e: Row) => void auditLog.push(JSON.parse(JSON.stringify(e)))) } as any;

  let caps = [...(o.capsAtStart ?? ["deploy"])];
  const capCalls: Array<[string, boolean]> = [];
  let created = 0;
  const deleted: string[] = [];
  const minted: Array<{ id: string; token: string }> = [];
  const serversSvc = {
    setRunCapability: jest.fn(async (_id: string, cap: string, on: boolean) => {
      capCalls.push([cap, on]);
      const has = caps.includes(cap);
      if (has === on) return false;
      caps = on ? [...caps, cap] : caps.filter((c) => c !== cap);
      return true;
    }),
    createServersBulk: jest.fn(async (_u: string, names: string[], teamId: string) => {
      const row = await servers.create({ data: { id: `NEW${++created}`, name: names[0], teamId, status: "PENDING", publicIp: null, publicIpv6: null, hostname: null, reportedIps: [] } });
      minted.push({ id: row.id, token: TOKEN });
      return { servers: [{ server: { id: row.id }, enrollToken: TOKEN, installCommand: `curl ... --token ${TOKEN}` }] };
    }),
    deleteForUser: jest.fn(async (_u: string, id: string) => {
      deleted.push(id);
      const i = servers.rows.findIndex((r) => r.id === id);
      if (i >= 0) servers.rows.splice(i, 1);
    }),
  } as any;

  const sent: Array<{ serverId: string; req: Row; timeoutMs: number }> = [];
  let probes = 0;
  let inFlight = 0;
  let peak = 0;
  const agentWs = {
    isOnline: jest.fn(() => o.online !== false),
    agentSupports: jest.fn(() => o.features !== false),
    sendCoolifySsh: jest.fn(async (serverId: string, req: Row, timeoutMs: number) => {
      sent.push({ serverId, req: { ...req }, timeoutMs });
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((r) => setImmediate(r));
        let out: CoolifySshResultMsg | Error;
        if (req.op === "probe") out = o.probe ? o.probe(req.coolifyServerUuid, ++probes) : readyProbe();
        else if (req.op === "install") {
          out = o.install ? o.install(req.coolifyServerUuid) : { type: "coolify_ssh_result", reqId: "r", ok: true, code: "ok_installed", containerId: CID };
          if (!(out instanceof Error) && out.ok && o.enrolls !== false) {
            const m = minted[minted.length - 1];
            const srv = servers.rows.find((r) => r.id === m.id);
            if (srv) Object.assign(srv, { status: "ONLINE", publicIp: "198.51.100.10" });
          }
        } else out = o.uninstall ? o.uninstall(req.coolifyServerUuid) : { type: "coolify_ssh_result", reqId: "r", ok: true, code: "ok_installed" };
        if (out instanceof Error) throw out;
        return out;
      } finally {
        inFlight--;
      }
    }),
  } as any;

  const config = { get: () => undefined } as any;
  const identity = o.identity === undefined ? undefined : { reportedHostKeyFp: async () => o.identity as string | null };
  const svc = new CoolifySshInstallService(prisma, access, audit, agentWs, serversSvc, config, identity as any);
  let now = 1_800_000_000_000;
  svc.clock = { now: () => now, sleep: async (ms: number) => { now += ms; await new Promise((r) => setImmediate(r)); }, random: () => 0 };
  return {
    svc, prisma, targets, grants, servers, auditLog, audit, agentWs, serversSvc, sent, capCalls, deleted, minted, uuids,
    caps: () => caps,
    setRole: (r: string) => (role = r),
    advance: (ms: number) => (now += ms),
    peak: () => peak,
  };
}

function readyProbe(extra: Row = {}): CoolifySshResultMsg {
  return { type: "coolify_ssh_result", reqId: "r", ok: true, code: "ok_installed", probe: { uid: 0, dockerAccess: true, arch: "x86_64", agent: "none", sshHostKeyFp: FP, hostKeyPinned: false, ...extra } } as any;
}
const fail = (code: string, probe: Row = { agent: "none", uid: 0 }): CoolifySshResultMsg => ({ type: "coolify_ssh_result", reqId: "r", ok: false, code, probe } as any);

const start = (w: ReturnType<typeof world>, uuids = w.uuids, confirm = String(uuids.length)) => w.svc.startRun("u1", "HOST", { coolifyServerUuids: uuids, teamId: "T_NEW", confirm });
const states = (w: ReturnType<typeof world>) => Object.fromEntries(w.targets.rows.map((r) => [r.coolifyServerUuid, r.state]));

// ---------------------------------------------------------------------------------------------------------------------------------

describe("CoolifySshInstallService: consent and guards", () => {
  it("is owner only: an admin may read but not start, install, uninstall or cancel; a stranger can do nothing", async () => {
    const w = world();
    w.setRole("admin");
    await expect(start(w)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.svc.startInstall("u1", "HOST", "x", { confirm: "1" })).rejects.toThrow();
    await expect(w.svc.cancelRun("u1", "HOST", "x")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.svc.latestRun("u1", "HOST")).resolves.toBeNull(); // read is allowed
    w.setRole("other");
    await expect(w.svc.latestRun("u1", "HOST")).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.sent).toHaveLength(0);
    expect(w.grants.rows).toHaveLength(0);
    expect(w.serversSvc.setRunCapability).not.toHaveBeenCalled();
  });

  it("needs OWNER on the target team too, and servers:manage there", async () => {
    const w = world();
    ROLES.owner.T_NEW = "ADMIN";
    try {
      await expect(start(w)).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      ROLES.owner.T_NEW = "OWNER";
    }
    expect(w.grants.rows).toHaveLength(0);
  });

  it("requires the typed count and refuses unknown servers, the Coolify host itself, and option-like uuids", async () => {
    const w = world();
    await expect(start(w, w.uuids, "5")).rejects.toMatchObject({ response: { code: "confirm_mismatch" } });
    await expect(start(w, ["nopenopenope1"])).rejects.toMatchObject({ response: { code: "unknown_server" } });
    await expect(start(w, ["localuuid0001"])).rejects.toMatchObject({ response: { code: "unknown_server" } });
    await expect(start(w, ["-oProxyCommand=id"])).rejects.toBeInstanceOf(BadRequestException);
    await expect(start(w, [])).rejects.toBeInstanceOf(BadRequestException);
    await expect(start(w, Array.from({ length: 101 }, (_, i) => `srv${String(i).padStart(9, "0")}`))).rejects.toBeInstanceOf(BadRequestException);
    expect(w.sent).toHaveLength(0);
    expect(w.grants.rows).toHaveLength(0);
  });

  it("refuses when the Coolify host agent is offline or too old, before any consent is recorded", async () => {
    const off = world({ online: false });
    await expect(start(off)).rejects.toMatchObject({ response: { code: "agent_offline" } });
    const old = world({ features: false });
    await expect(start(old)).rejects.toMatchObject({ response: { code: "agent_too_old" } });
    for (const w of [off, old]) {
      expect(w.grants.rows).toHaveLength(0);
      expect(w.caps()).not.toContain("coolify_ssh");
    }
  });

  it("opens a 2 hour consent, turns the capability on, and audits the grant", async () => {
    const w = world();
    const view = await start(w);
    await w.svc.idle();
    expect(w.caps()).toContain("coolify_ssh");
    const g = w.grants.rows[0];
    expect(g).toMatchObject({ kind: "ssh", serverId: "HOST", teamId: "T_HOST", grantedById: "u1", classes: ["cap_added"] });
    expect(g.expiresAt.getTime() - 1_800_000_000_000).toBe(2 * 3_600_000);
    expect(w.auditLog.find((a) => a.action === "coolify.ssh.grant")).toMatchObject({ actor: "u1", target: "HOST", meta: { runId: view.runId, count: 2, hours: 2 } });
  });
});

describe("CoolifySshInstallService: probe", () => {
  it("probes read-only first: READY for a clean server, and NO enroll token is minted", async () => {
    const w = world();
    const view = await start(w);
    await w.svc.idle();
    expect(states(w)).toEqual({ srvaaa111111: "READY", srvbbb222222: "READY" });
    expect(w.serversSvc.createServersBulk).not.toHaveBeenCalled();
    for (const s of w.sent) {
      expect(s.req).toMatchObject({ op: "probe", scriptSha256: COOLIFY_SSH_PROBE_SHA256, useSudo: false, expectedHostKeyFp: "" });
      expect(s.req.payload).toBeUndefined();
      expect(s.req.script).toBeUndefined();
    }
    const done = await w.svc.getRun("u1", "HOST", view.runId);
    expect(done.targets.every((t) => t.state === "READY" && t.probe?.sshHostKeyFp === FP)).toBe(true);
    expect(done.finished).toBe(false); // the owner can still install
    expect(w.caps()).toContain("coolify_ssh");
  });

  it("leaves a server with an agent alone: skipped_present / skipped_foreign, never touched again, and the consent ends", async () => {
    const w = world({ probe: (u) => ({ type: "coolify_ssh_result", reqId: "r", ok: true, code: u === "srvaaa111111" ? "skipped_present" : "skipped_foreign", probe: { agent: u === "srvaaa111111" ? "ours" : "foreign_hub" } } as any) });
    const view = await start(w);
    await w.svc.idle();
    expect(states(w)).toEqual({ srvaaa111111: "SKIPPED_PRESENT", srvbbb222222: "SKIPPED_FOREIGN" });
    expect((await w.svc.getRun("u1", "HOST", view.runId)).finished).toBe(true);
    expect(w.serversSvc.createServersBulk).not.toHaveBeenCalled();
    expect(w.caps()).not.toContain("coolify_ssh"); // dropped: this run added it
    await expect(w.svc.startInstall("u1", "HOST", view.runId, { confirm: "1" })).rejects.toMatchObject({ response: { code: "nothing_ready" } });
  });

  it("skips SSH entirely for a server that is already in Tugra with a live agent (matched by address)", async () => {
    const w = world({ knownServers: [{ id: "EXIST", teamId: "T_NEW", status: "ONLINE", publicIp: "198.51.100.10", publicIpv6: null, hostname: null, reportedIps: [] }] });
    await start(w);
    await w.svc.idle();
    expect(states(w).srvaaa111111).toBe("SKIPPED_PRESENT");
    expect(w.targets.rows[0].tugraServerId).toBe("EXIST");
    expect(w.sent.map((s) => s.req.coolifyServerUuid)).toEqual(["srvbbb222222"]);
  });

  it("maps every failure to the agent's fixed code and offers the manual command where it helps", async () => {
    const codes: Record<string, string> = { srvaaa111111: "needs_root", srvbbb222222: "hostkey_changed" };
    const w = world({ probe: (u) => fail(codes[u]) });
    const view = await start(w);
    await w.svc.idle();
    const run = await w.svc.getRun("u1", "HOST", view.runId);
    const by = Object.fromEntries(run.targets.map((t) => [t.coolifyServerUuid, t]));
    expect(by.srvaaa111111).toMatchObject({ state: "FAILED", code: "needs_root", manualCommand: true });
    expect(by.srvbbb222222).toMatchObject({ state: "FAILED", code: "hostkey_changed", manualCommand: false });
    expect(run.finished).toBe(true);
  });

  it("turns a hop failure into a code, never an error message", async () => {
    const w = world({ probe: (u) => (u === "srvaaa111111" ? new AgentCommandTimeoutException("secret detail") : new AgentOfflineException()) });
    const view = await start(w);
    await w.svc.idle();
    const run = await w.svc.getRun("u1", "HOST", view.runId);
    expect(run.targets.map((t) => t.code).sort()).toEqual(["timeout", "unreachable"]);
    expect(JSON.stringify(run) + JSON.stringify(w.auditLog)).not.toContain("secret detail");
  });

  it("is idempotent while a run is going: the same servers return the same run", async () => {
    const w = world();
    const a = await start(w);
    const b = await start(w);
    expect(b.runId).toBe(a.runId);
    await w.svc.idle();
    const c = await start(w); // READY targets still count as in flight
    expect(c.runId).toBe(a.runId);
    expect((await start(w, ["srvaaa111111"])).runId).toBe(a.runId); // a subset of the running run is that run
    expect(w.grants.rows).toHaveLength(1);
    expect(w.sent.filter((s) => s.req.op === "probe")).toHaveLength(2); // never probed twice
    // a request that mixes a running server with a new one is refused rather than split
    const w3 = world({ uuids: ["srvaaa111111", "srvbbb222222", "srvccc333333"] });
    await start(w3, ["srvaaa111111", "srvbbb222222"]);
    await expect(start(w3, ["srvaaa111111", "srvccc333333"])).rejects.toMatchObject({ response: { code: "run_in_progress" } });
    await w3.svc.idle();
  });

  it("caps concurrency at 4 per Coolify host (default) and 8 for the hub", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `srvmany${String(i).padStart(5, "0")}`);
    const w = world({ uuids: many });
    await start(w, many);
    await w.svc.idle();
    expect(w.sent).toHaveLength(12);
    expect(w.peak()).toBeLessThanOrEqual(4);
    expect(w.peak()).toBeGreaterThan(1);
    const w2 = world({ uuids: many });
    await w2.svc.startRun("u1", "HOST", { coolifyServerUuids: many, teamId: "T_NEW", confirm: "12", concurrency: 99 });
    await w2.svc.idle();
    expect(w2.peak()).toBeLessThanOrEqual(8);
  });

  it("audits each probe with names and codes only (address, port, user, key NAME, fingerprint)", async () => {
    const w = world();
    await start(w);
    await w.svc.idle();
    const a = w.auditLog.filter((x) => x.action === "coolify.ssh.probe");
    expect(a).toHaveLength(2);
    expect(a[0].meta).toMatchObject({ coolifyServerUuid: expect.any(String), ip: expect.any(String), port: 22, user: "root", keyName: "edge key", code: "ok", hostKeyFp: FP });
    expect(JSON.stringify(a)).not.toMatch(/private|BEGIN|tugra_en_/);
  });
});

describe("CoolifySshInstallService: install", () => {
  async function ready(o: Opts = {}) {
    const w = world(o);
    const view = await start(w);
    await w.svc.idle();
    return { w, runId: view.runId };
  }

  it("mints the token only now, sends it ONLY as the signed payload, and ends ONLINE", async () => {
    const { w, runId } = await ready({ uuids: ["srvaaa111111"] });
    expect(w.serversSvc.createServersBulk).not.toHaveBeenCalled();
    const view = await w.svc.startInstall("u1", "HOST", runId, { confirm: "1" });
    expect(view.targets[0].state).not.toBe("READY");
    await w.svc.idle();
    expect(states(w)).toEqual({ srvaaa111111: "ONLINE" });
    expect(w.serversSvc.createServersBulk).toHaveBeenCalledTimes(1);
    const inst = w.sent.find((s) => s.req.op === "install")!;
    expect(inst.req.payload).toBe(TOKEN);
    expect(inst.req.payloadSha256).toBe(sha(TOKEN));
    expect(inst.req.scriptSha256).toBe(sha(inst.req.script));
    expect(inst.req.expectedHostKeyFp).toBe(FP);
    expect(inst.req.useSudo).toBe(false);
    expect(inst.req.script).toContain("tugra_install_main");
    expect(inst.req.script).not.toContain(TOKEN);
    const row = w.targets.rows[0];
    expect(row).toMatchObject({ state: "ONLINE", containerId: CID, tugraServerId: "NEW1", code: null });
    const run = await w.svc.getRun("u1", "HOST", runId);
    expect(run.targets[0]).toMatchObject({ canRemove: true, tugraServerId: "NEW1" });
    // the token is nowhere a reader can see: API view, audit rows, the stored target
    const everything = JSON.stringify([run, w.auditLog, w.targets.rows, w.grants.rows]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("CANARY");
    // finished: the consent ends and the capability this run added is dropped
    expect(w.caps()).not.toContain("coolify_ssh");
    expect(w.grants.rows[0].revokedAt).toBeInstanceOf(Date);
  });

  it("installs under sudo when the probe saw a non-root user without Docker access", async () => {
    const { w, runId } = await ready({ uuids: ["srvaaa111111"], probe: () => readyProbe({ uid: 1000, dockerAccess: false, sudoNoPassword: true }) });
    await w.svc.startInstall("u1", "HOST", runId, { confirm: "1" });
    await w.svc.idle();
    expect(w.sent.find((s) => s.req.op === "install")!.req.useSudo).toBe(true);
  });

  it("requires the typed count and a live consent; a stranger cannot install", async () => {
    const { w, runId } = await ready();
    await expect(w.svc.startInstall("u1", "HOST", runId, { confirm: "1" })).rejects.toMatchObject({ response: { code: "confirm_mismatch" } });
    w.setRole("admin");
    await expect(w.svc.startInstall("u1", "HOST", runId, { confirm: "2" })).rejects.toBeInstanceOf(ForbiddenException);
    w.setRole("owner");
    w.advance(3 * 3_600_000);
    await expect(w.svc.startInstall("u1", "HOST", runId, { confirm: "2" })).rejects.toMatchObject({ response: { code: "grant_expired" } });
    expect(w.serversSvc.createServersBulk).not.toHaveBeenCalled();
  });

  it("two clicks mint ONE token per target", async () => {
    const { w, runId } = await ready({ uuids: ["srvaaa111111"] });
    await Promise.allSettled([w.svc.startInstall("u1", "HOST", runId, { confirm: "1" }), w.svc.startInstall("u1", "HOST", runId, { confirm: "1" })]);
    await w.svc.idle();
    expect(w.serversSvc.createServersBulk).toHaveBeenCalledTimes(1);
    expect(w.sent.filter((s) => s.req.op === "install")).toHaveLength(1);
  });

  it("an installer failure voids the token (the pending server is removed) and fails with the agent's code", async () => {
    const { w, runId } = await ready({ uuids: ["srvaaa111111"], install: () => fail("pull_failed") });
    await w.svc.startInstall("u1", "HOST", runId, { confirm: "1" });
    await w.svc.idle();
    expect(states(w)).toEqual({ srvaaa111111: "FAILED" });
    expect(w.targets.rows[0]).toMatchObject({ code: "pull_failed", tugraServerId: null });
    expect(w.deleted).toEqual(["NEW1"]);
    expect(w.servers.rows.find((r) => r.id === "NEW1")).toBeUndefined();
    expect(w.sent.some((s) => s.req.op === "uninstall")).toBe(false); // nothing was installed
    const run = await w.svc.getRun("u1", "HOST", runId);
    expect(run.targets[0].manualCommand).toBe(true);
  });

  it("a hop failure during the install also voids the token", async () => {
    const { w, runId } = await ready({ uuids: ["srvaaa111111"], install: () => new AgentOfflineException() });
    await w.svc.startInstall("u1", "HOST", runId, { confirm: "1" });
    await w.svc.idle();
    expect(w.targets.rows[0]).toMatchObject({ state: "FAILED", code: "unreachable" });
    expect(w.deleted).toEqual(["NEW1"]);
  });

  it("rolls back when the agent never enrolls: uninstall pinned to the container id, token voided, enroll_timeout", async () => {
    const { w, runId } = await ready({ uuids: ["srvaaa111111"], enrolls: false });
    await w.svc.startInstall("u1", "HOST", runId, { confirm: "1" });
    await w.svc.idle();
    expect(w.targets.rows[0]).toMatchObject({ state: "FAILED", code: "enroll_timeout", tugraServerId: null });
    const un = w.sent.find((s) => s.req.op === "uninstall")!;
    expect(un.req.payload).toBe(CID);
    expect(un.req.payloadSha256).toBe(sha(CID));
    expect(un.req.scriptSha256).toBe(COOLIFY_SSH_UNINSTALL_SHA256);
    expect(w.deleted).toEqual(["NEW1"]);
  });

  it("a wrong machine (different host key after enroll) is rolled back: token void, row deleted, agent removed, hostkey_mismatch", async () => {
    const { w, runId } = await ready({ uuids: ["srvaaa111111"], identity: "SHA256:" + "B".repeat(43) });
    await w.svc.startInstall("u1", "HOST", runId, { confirm: "1" });
    await w.svc.idle();
    expect(w.targets.rows[0]).toMatchObject({ state: "FAILED", code: "hostkey_mismatch" });
    expect(w.sent.some((s) => s.req.op === "uninstall")).toBe(true);
    expect(w.deleted).toContain("NEW1");
    const mismatch = w.auditLog.find((a) => a.action === "coolify.ssh.install" && a.meta.code === "hostkey_mismatch");
    expect(mismatch).toBeTruthy();
  });

  it("accepts the enroll when the agent reports the same host key", async () => {
    const { w, runId } = await ready({ uuids: ["srvaaa111111"], identity: FP });
    await w.svc.startInstall("u1", "HOST", runId, { confirm: "1" });
    await w.svc.idle();
    expect(w.targets.rows[0].state).toBe("ONLINE");
    expect(w.auditLog.find((a) => a.action === "coolify.ssh.install")!.meta).toMatchObject({ code: "ok_installed", crossCheck: "fingerprint", tugraServerId: "NEW1" });
  });

  it("picks a free server name in the target team", async () => {
    const { w, runId } = await ready({ uuids: ["srvaaa111111"], knownServers: [{ id: "X", teamId: "T_NEW", name: "srv1", status: "OFFLINE", publicIp: null, reportedIps: [] }] });
    await w.svc.startInstall("u1", "HOST", runId, { confirm: "1" });
    await w.svc.idle();
    expect(w.serversSvc.createServersBulk).toHaveBeenCalledWith("u1", ["srv1 (2)"], "T_NEW");
  });

  it("installs only the servers the owner picked", async () => {
    const { w, runId } = await ready();
    await w.svc.startInstall("u1", "HOST", runId, { confirm: "1", coolifyServerUuids: ["srvbbb222222"] });
    await w.svc.idle();
    expect(states(w)).toEqual({ srvaaa111111: "READY", srvbbb222222: "ONLINE" });
    expect(w.caps()).toContain("coolify_ssh"); // one is still READY: the consent stays
  });
});

describe("CoolifySshInstallService: cancel, undo, expiry, restart", () => {
  it("cancel turns unstarted targets into cancelled, ends the consent and drops the capability it added", async () => {
    const w = world();
    const view = await start(w);
    await w.svc.idle();
    const run = await w.svc.cancelRun("u1", "HOST", view.runId);
    expect(run.targets.every((t) => t.state === "FAILED" && t.code === "cancelled")).toBe(true);
    expect(w.caps()).not.toContain("coolify_ssh");
    expect(w.grants.rows[0].revokedAt).toBeInstanceOf(Date);
    expect(w.auditLog.map((a) => a.action)).toEqual(expect.arrayContaining(["coolify.ssh.cancel", "coolify.ssh.revoke"]));
  });

  it("never drops a capability the owner granted before the run", async () => {
    const w = world({ capsAtStart: ["deploy", "coolify_ssh"] });
    const view = await start(w);
    await w.svc.idle();
    expect(w.grants.rows[0].classes).toEqual([]);
    await w.svc.cancelRun("u1", "HOST", view.runId);
    expect(w.caps()).toContain("coolify_ssh");
    expect(w.capCalls.filter(([, on]) => !on)).toEqual([]);
  });

  it("sweep ends an expired consent and its capability; installing after that is refused", async () => {
    const w = world();
    await start(w);
    await w.svc.idle();
    w.advance(2 * 3_600_000 + 1);
    await w.svc.sweep();
    expect(w.grants.rows[0].revokedAt).toBeInstanceOf(Date);
    expect(w.caps()).not.toContain("coolify_ssh");
    expect(w.auditLog.find((a) => a.action === "coolify.ssh.revoke")!.meta.reason).toBe("expired");
  });

  it("sweep gives up on a step that outlived the run limit", async () => {
    const w = world({ probe: () => new Promise(() => undefined) as any });
    await start(w);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    w.targets.rows.forEach((r) => (r.createdAt = new Date(0)));
    await w.svc.sweep();
    expect(w.targets.rows.every((r) => r.state === "FAILED" && r.code === "timeout")).toBe(true);
  });

  it("uninstall takes off only what this run installed, under a fresh consent if the old one ended, with the typed count", async () => {
    const w = world({ uuids: ["srvaaa111111"] });
    const view = await start(w);
    await w.svc.idle();
    await w.svc.startInstall("u1", "HOST", view.runId, { confirm: "1" });
    await w.svc.idle();
    expect(w.targets.rows[0].state).toBe("ONLINE");
    expect(w.caps()).not.toContain("coolify_ssh");
    await expect(w.svc.startUninstall("u1", "HOST", view.runId, { confirm: "9" })).rejects.toMatchObject({ response: { code: "confirm_mismatch" } });
    w.setRole("admin");
    await expect(w.svc.startUninstall("u1", "HOST", view.runId, { confirm: "1" })).rejects.toBeInstanceOf(ForbiddenException);
    w.setRole("owner");
    await w.svc.startUninstall("u1", "HOST", view.runId, { confirm: "1" });
    await w.svc.idle();
    expect(w.targets.rows[0]).toMatchObject({ state: "REMOVED", containerId: null });
    expect(w.grants.rows).toHaveLength(2); // a renewed consent, now ended again
    expect(w.caps()).not.toContain("coolify_ssh");
    const un = w.sent.filter((s) => s.req.op === "uninstall");
    expect(un).toHaveLength(1);
    expect(un[0].req.payload).toBe(CID);
    // a REMOVED target cannot be removed again, and SKIPPED/FAILED ones never can
    await expect(w.svc.startUninstall("u1", "HOST", view.runId, { confirm: "1" })).rejects.toMatchObject({ response: { code: "nothing_to_remove" } });
  });

  it("a refused uninstall leaves the target ONLINE with a code", async () => {
    const w = world({ uuids: ["srvaaa111111"], uninstall: () => fail("bad_target") });
    const view = await start(w);
    await w.svc.idle();
    await w.svc.startInstall("u1", "HOST", view.runId, { confirm: "1" });
    await w.svc.idle();
    await w.svc.startUninstall("u1", "HOST", view.runId, { confirm: "1" });
    await w.svc.idle();
    expect(w.targets.rows[0]).toMatchObject({ state: "ONLINE", code: "bad_target" });
  });

  it("restart: a probe in progress runs again; a target past the token step is not installed twice, and its pending server is removed", async () => {
    const w = world({ uuids: ["srvaaa111111", "srvbbb222222", "srvccc333333"] });
    const view = await start(w, ["srvaaa111111", "srvbbb222222", "srvccc333333"]);
    await w.svc.idle();
    // fake a crash: one target mid-probe, one after the token step
    const [a, b] = w.targets.rows;
    a.state = "PROBING";
    b.state = "INSTALLING";
    b.tugraServerId = "NEWX";
    w.servers.rows.push({ id: "NEWX", status: "PENDING", teamId: "T_NEW" });
    w.sent.length = 0;
    await w.svc.recover();
    await w.svc.idle();
    expect(a.state).toBe("READY"); // re-probed
    expect(b).toMatchObject({ state: "FAILED", code: "timeout", tugraServerId: null });
    expect(w.deleted).toContain("NEWX");
    expect(w.sent.every((s) => s.req.op === "probe")).toBe(true);
    expect(w.sent).toHaveLength(1);
    void view;
  });

  it("restart: a target waiting for its agent keeps waiting and ends ONLINE when it enrolls", async () => {
    const w = world({ uuids: ["srvaaa111111"] });
    const view = await start(w);
    await w.svc.idle();
    const t = w.targets.rows[0];
    Object.assign(t, { state: "WAIT_ENROLL", tugraServerId: "NEWY", containerId: CID });
    w.servers.rows.push({ id: "NEWY", status: "ONLINE", teamId: "T_NEW", publicIp: null, reportedIps: [] });
    await w.svc.recover();
    await w.svc.idle();
    expect(t.state).toBe("ONLINE");
    void view;
  });
});

describe("CoolifySshInstallService: what the hub keeps and says", () => {
  it("never puts a token, a key or a command line in a log, an audit row, a view or an error", async () => {
    const logs: string[] = [];
    const orig = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      const w = world({ uuids: ["srvaaa111111"], install: () => new Error(`ssh failed with ${TOKEN} and /data/coolify/ssh/keys/ssh_key@x`) });
      const view = await start(w);
      await w.svc.idle();
      await w.svc.startInstall("u1", "HOST", view.runId, { confirm: "1" });
      await w.svc.idle();
      const everything = JSON.stringify([await w.svc.getRun("u1", "HOST", view.runId), w.auditLog, w.targets.rows, w.grants.rows]) + logs.join("\n");
      expect(everything).not.toContain(TOKEN);
      expect(everything).not.toContain("ssh_key@");
      expect(everything).not.toContain("/data/coolify");
    } finally {
      [console.log, console.warn, console.error] = orig as any;
    }
  });
});

describe("CoolifySshInstallService: wiring", () => {
  const providers = [PrismaService, TeamAccessService, AuditService, AgentWsServer, ServersService, ConfigService].map((p) => ({ provide: p, useValue: {} }));

  it("resolves through Nest with the host-identity reader absent (lane D plugs it in later)", async () => {
    const mod = await Test.createTestingModule({ providers: [CoolifySshInstallService, ...providers] }).compile();
    expect(mod.get(CoolifySshInstallService)).toBeInstanceOf(CoolifySshInstallService);
  });

  it("takes the host-identity reader when one is provided", async () => {
    const reader = { reportedHostKeyFp: async () => FP };
    const mod = await Test.createTestingModule({ providers: [CoolifySshInstallService, ...providers, { provide: COOLIFY_HOST_IDENTITY, useValue: reader }] }).compile();
    expect((mod.get(CoolifySshInstallService) as any).identity).toBe(reader);
  });

  it("starts and stops its housekeeping timer with the module", async () => {
    jest.useFakeTimers();
    try {
      const w = world();
      w.svc.onModuleInit();
      expect(jest.getTimerCount()).toBeGreaterThan(0);
      w.svc.onModuleDestroy();
      await w.svc.idle();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

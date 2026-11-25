import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { CoolifyCleanupService } from "./coolify-cleanup.service";
import { listHash } from "./remnant-scan";
import type { CoolifyInventoryData } from "../coolify-takeover/coolify-inventory";

const CANARY = "s3cr3t-canary-value-9f3a";
const SERVER = { id: "s1", teamId: "t1", name: "olgu-box", publicIp: "203.0.113.10", publicIpv6: null, hostname: "box", reportedIps: [] as string[] };

const inventory = (over: Partial<CoolifyInventoryData> = {}): CoolifyInventoryData => ({
  v: 1,
  instance: { name: null, fqdn: null, ip: null, image: null },
  teams: [{ id: "1", name: "Team", description: null, personal: false, members: 1, notifications: [] }],
  servers: [
    { id: "0", uuid: "local", name: "localhost", description: null, ip: "10.0.0.1", port: 22, user: "root", teamId: "1", isLocal: true, reachable: true, usable: true, buildServer: false, swarm: false, keyName: null, apps: 0, databases: 0, services: 0 },
    { id: "5", uuid: "srv5", name: "olgu", description: null, ip: "203.0.113.10", port: 22, user: "root", teamId: "1", isLocal: false, reachable: true, usable: true, buildServer: false, swarm: false, keyName: null, apps: 1, databases: 0, services: 0 },
  ],
  projects: [],
  applications: [{ id: "9", uuid: "uuidapp1uuidapp1uuidapp1", name: "blog", fqdn: "https://blog.example.com", gitRepository: null, gitBranch: null, buildPack: null, image: null, status: "running:healthy", envCount: 2, previewEnvCount: 0, hasCompose: false, teamId: "1", projectId: null, environment: null, serverId: "5" }],
  databases: [],
  services: [],
  sharedVariables: [],
  scheduledTasks: [],
  backups: [],
  storages: [],
  gitSources: [],
  unavailable: ["volumes_not_carried_yet"],
  ...over,
});

const SCAN_OK = (extra: string[] = []) =>
  ["TUGRA_CU_BEGIN", "TUGRA_CU_C|coolify-proxy|traefik:v3.1|exited|true", "TUGRA_CU_N|coolify|0", "TUGRA_CU_V|uuidapp1uuidapp1uuidapp1-data", ...extra, "TUGRA_CU_END"].join("\n");
const SCAN_CLEAN = "TUGRA_CU_BEGIN\nTUGRA_CU_END\n";

interface Opts {
  role?: string | null;
  online?: boolean;
  inv?: CoolifyInventoryData | null;
  invServerId?: string;
  links?: Record<string, { serverId: string }>;
  apps?: Array<Record<string, unknown>>;
  scripts?: (script: string, n: number) => { exitCode: number; output: string } | Error;
}

function make(o: Opts = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const calls: string[] = [];
  const audits: Array<{ action: string; meta?: Record<string, unknown> }> = [];
  const caps: boolean[] = [];
  const sent: Array<{ script: string; capability: string }> = [];
  const volumesFixture = [{ name: "data", path: "/data" }];
  const inv = o.inv === undefined ? inventory() : o.inv;
  const prisma = {
    server: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === "s1" ? SERVER : null)) },
    coolifyInventory: { findMany: jest.fn(async () => (inv ? [{ id: "i1", teamId: "t1", serverId: o.invServerId ?? "hub", snapshot: inv, serverLinks: o.links ?? {} }] : [])) },
    application: {
      findMany: jest.fn(async () => o.apps ?? [{ id: "a1", name: "blog", status: "RUNNING", envEnc: "ENC", domain: "blog.example.com", extraDomains: [], domainRedirect: null, volumes: volumesFixture, composeFile: null, domains: [] }]),
    },
    database: { findMany: jest.fn(async () => []) },
    notificationChannel: { findMany: jest.fn(async () => []) },
    scheduledTask: { findMany: jest.fn(async () => []) },
    bulkTask: { findMany: jest.fn(async () => []) },
    coolifyTakeover: { updateMany: jest.fn(async () => ({ count: 1 })) },
    coolifyCleanup: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `c${++seq}`, completeness: [], remnants: [], results: [], failureCode: null, confirmedAt: null, cleanedAt: null, confirmedById: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        rows.set(row.id, row);
        return { ...row };
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (rows.get(where.id) ? { ...rows.get(where.id)! } : null)),
      findFirst: jest.fn(async ({ where }: { where: { status?: { in: string[] }; serverId: string } }) => [...rows.values()].reverse().find((r) => r.serverId === where.serverId && (!where.status || where.status.in.includes(r.status as string))) ?? null),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id);
        if (!row || row.status !== where.status) return { count: 0 };
        Object.assign(row, data, { updatedAt: new Date() });
        return { count: 1 };
      }),
    },
  };
  const access = {
    teamRole: jest.fn(async () => (o.role === undefined ? "OWNER" : o.role)),
    teamIds: jest.fn(async () => ["t1"]),
  };
  const audit = { log: jest.fn(async (a: { action: string; meta?: Record<string, unknown> }) => void audits.push(a)) };
  const agentWs = {
    isOnline: jest.fn(() => o.online !== false),
    sendCommand: jest.fn(async (_id: string, script: string, capability: string) => {
      sent.push({ script, capability });
      const r = o.scripts ? o.scripts(script, sent.length) : { exitCode: 0, output: SCAN_OK() };
      if (r instanceof Error) throw r;
      return r;
    }),
  };
  const servers = {
    setRunCapability: jest.fn(async (_id: string, _cap: string, granted: boolean) => {
      caps.push(granted);
      return true;
    }),
  };
  const crypto = { decrypt: jest.fn(() => JSON.stringify({ A: CANARY, B: CANARY })) };
  const svc = new CoolifyCleanupService(prisma as never, access as never, audit as never, agentWs as never, servers as never, crypto as never);
  return { svc, prisma, access, audit, audits, agentWs, servers, caps, sent, calls, rows, crypto };
}

/** Scans return the same list until the removal script has run; after it, the scan returns `after`. */
const afterRemoval = (removalOutput: string, after: string) => {
  let removed = false;
  return (script: string) => {
    if (isRemoval(script)) {
      removed = true;
      return { exitCode: 0, output: removalOutput };
    }
    return { exitCode: 0, output: removed ? after : SCAN_OK() };
  };
};
const isRemoval = (script: string) => /rm -rf|docker rm|docker rmi|docker network rm/.test(script);

describe("CoolifyCleanupService.check", () => {
  it("only a team owner may check: an admin or a stranger is refused before anything runs", async () => {
    for (const role of ["ADMIN", "VIEWER", null]) {
      const t = make({ role });
      await expect(t.svc.check("u1", "s1")).rejects.toBeInstanceOf(ForbiddenException);
      expect(t.agentWs.sendCommand).not.toHaveBeenCalled();
      expect(t.prisma.coolifyCleanup.create).not.toHaveBeenCalled();
    }
  });

  it("an offline agent is a 503 and leaves no row", async () => {
    const t = make({ online: false });
    await expect(t.svc.check("u1", "s1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(t.prisma.coolifyCleanup.create).not.toHaveBeenCalled();
  });

  it("no stored Coolify read that knows the server: 409 no_coolify_link, row FAILED, nothing sent", async () => {
    const t = make({ inv: null });
    await expect(t.svc.check("u1", "s1")).rejects.toMatchObject({ response: expect.objectContaining({ code: "no_coolify_link" }) });
    expect([...t.rows.values()][0]).toMatchObject({ status: "FAILED", failureCode: "no_coolify_link" });
    expect(t.agentWs.sendCommand).not.toHaveBeenCalled();
  });

  it("the Coolify host itself is refused (it is retired separately)", async () => {
    const t = make({ invServerId: "s1" });
    await expect(t.svc.check("u1", "s1")).rejects.toBeInstanceOf(ConflictException);
    expect([...t.rows.values()][0]).toMatchObject({ failureCode: "control_plane" });
    const t2 = make({ inv: inventory({ servers: [{ ...inventory().servers[1], isLocal: true }] }), links: { "5": { serverId: "s1" } } });
    await expect(t2.svc.check("u1", "s1")).rejects.toMatchObject({ response: expect.objectContaining({ code: "control_plane" }) });
  });

  it("a control-plane container found by the scan fails the check", async () => {
    const t = make({ scripts: () => ({ exitCode: 0, output: SCAN_OK(["TUGRA_CU_C|coolify-db|postgres:15|running|"]) }) });
    const v = await t.svc.check("u1", "s1");
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("control_plane");
    expect(v.remnants.every((r) => r.keep)).toBe(true);
  });

  it("incomplete: lists what is missing, offers no list hash to confirm, and never sends a removal", async () => {
    const t = make({ apps: [] });
    const v = await t.svc.check("u1", "s1");
    expect(v.status).toBe("INCOMPLETE");
    expect(v.complete).toBe(false);
    expect(v.completeness.find((r) => r.kind === "application")?.missing).toEqual(["blog"]);
    expect(t.sent.some((s) => isRemoval(s.script))).toBe(false);
  });

  it("the stored read has no volume list: the host's docker volume names stand in, and a Coolify volume Tugra lacks keeps it closed", async () => {
    const t = make({ apps: [{ id: "a1", name: "blog", status: "RUNNING", envEnc: "ENC", domain: "blog.example.com", extraDomains: [], domainRedirect: null, volumes: [], composeFile: null, domains: [] }] });
    const v = await t.svc.check("u1", "s1");
    expect(v.completeness.find((r) => r.kind === "volume")).toMatchObject({ coolify: 1, tugra: 0, missing: ["blog/data"] });
    expect(v.status).toBe("INCOMPLETE");
  });

  it("a stored read that lists the volumes is used as it is, not replaced by the host's names", async () => {
    const t = make({ inv: inventory({ applications: [{ ...inventory().applications[0], volumes: ["uuidapp1uuidapp1uuidapp1-uploads"] } as never] }) });
    const v = await t.svc.check("u1", "s1");
    expect(v.completeness.find((r) => r.kind === "volume")?.missing).toEqual(["blog/uploads"]);
  });

  it("complete: READY with the removable list and its fingerprint; the capability is granted for the scan and taken away again", async () => {
    const t = make();
    const v = await t.svc.check("u1", "s1");
    expect(v.status).toBe("READY");
    expect(v.complete).toBe(true);
    expect(v.remnants.filter((r) => !r.keep).map((r) => `${r.kind}:${r.name}`)).toEqual(["container:coolify-proxy", "network:coolify"]);
    expect(v.listHash).toBe(listHash(v.remnants));
    expect(t.caps).toEqual([true, false]);
    expect(t.sent.map((s) => s.capability)).toEqual(["coolify_cleanup"]);
    expect(t.audits.map((a) => a.action)).toEqual(["coolify.cleanup.check", "coolify.cleanup.scan"]);
  });

  it("an unreadable scan fails the check instead of reading as empty", async () => {
    const t = make({ scripts: () => ({ exitCode: 0, output: "TUGRA_CU_BEGIN\nTUGRA_CU_C|coolify-proxy|x|exited|true" }) });
    const v = await t.svc.check("u1", "s1");
    expect(v).toMatchObject({ status: "FAILED", failureCode: "scan_unreadable" });
  });

  it("an agent error fails the check with a fixed code and still revokes the capability", async () => {
    const t = make({ scripts: () => new Error("boom with CANARY") });
    const v = await t.svc.check("u1", "s1");
    expect(v).toMatchObject({ status: "FAILED", failureCode: "agent_error" });
    expect(t.caps).toEqual([true, false]);
    expect(JSON.stringify(v)).not.toContain("boom");
  });

  it("a second check while one is running is a 409", async () => {
    const t = make();
    t.rows.set("c0", { id: "c0", serverId: "s1", status: "CLEANING", updatedAt: new Date() });
    await expect(t.svc.check("u1", "s1")).rejects.toMatchObject({ response: expect.objectContaining({ code: "cleanup_active" }) });
  });
});

describe("CoolifyCleanupService.confirm", () => {
  async function ready(o: Opts = {}) {
    const t = make(o);
    const v = await t.svc.check("u1", "s1");
    t.sent.length = 0;
    t.caps.length = 0;
    t.audits.length = 0;
    return { t, v };
  }

  it("a stranger, an admin and an unconfirmed name are refused and nothing is removed", async () => {
    const { t, v } = await ready();
    t.access.teamRole.mockResolvedValue("ADMIN");
    await expect(t.svc.confirm("u1", v.id, { confirm: "olgu-box", listHash: v.listHash! })).rejects.toBeInstanceOf(ForbiddenException);
    t.access.teamRole.mockResolvedValue("OWNER");
    await expect(t.svc.confirm("u1", v.id, { confirm: "wrong", listHash: v.listHash! })).rejects.toBeInstanceOf(BadRequestException);
    expect(t.sent).toHaveLength(0);
  });

  it("a list hash that is not the one the owner saw is refused", async () => {
    const { t, v } = await ready();
    await expect(t.svc.confirm("u1", v.id, { confirm: "olgu-box", listHash: "0".repeat(64) })).rejects.toMatchObject({ response: expect.objectContaining({ code: "list_changed" }) });
    expect(t.sent).toHaveLength(0);
  });

  it("an incomplete checklist can never be confirmed", async () => {
    const t = make({ apps: [] });
    const v = await t.svc.check("u1", "s1");
    await expect(t.svc.confirm("u1", v.id, { confirm: "olgu-box", listHash: v.listHash ?? "0".repeat(64) })).rejects.toMatchObject({ response: expect.objectContaining({ code: "incomplete" }) });
    expect(t.sent.some((s) => isRemoval(s.script))).toBe(false);
  });

  it("goes incomplete between the check and the confirm: refused, nothing removed", async () => {
    const { t, v } = await ready();
    t.prisma.application.findMany.mockResolvedValue([]);
    await expect(t.svc.confirm("u1", v.id, { confirm: "olgu-box", listHash: v.listHash! })).rejects.toMatchObject({ response: expect.objectContaining({ code: "incomplete" }) });
    expect(t.sent.some((s) => isRemoval(s.script))).toBe(false);
    expect(t.rows.get(v.id)).toMatchObject({ status: "INCOMPLETE" });
  });

  it("the list changed on the host since the check: refused, the new list is stored for a second look", async () => {
    let calls = 0;
    const { t, v } = await ready({ scripts: () => ({ exitCode: 0, output: ++calls === 1 ? SCAN_OK() : SCAN_OK(["TUGRA_CU_C|coolify-sentinel|ghcr.io/coollabsio/sentinel:1|running|"]) }) });
    await expect(t.svc.confirm("u1", v.id, { confirm: "olgu-box", listHash: v.listHash! })).rejects.toMatchObject({ response: expect.objectContaining({ code: "list_changed" }) });
    expect(t.sent.some((s) => isRemoval(s.script))).toBe(false);
    expect(t.rows.get(v.id)).toMatchObject({ status: "READY" });
  });

  it("removes exactly the confirmed list, verifies by a rescan, ends CLEANED and closes 'give back to Coolify'", async () => {
    const { t, v } = await ready({ scripts: afterRemoval("TUGRA_CU_R|container|coolify-proxy|ok\nTUGRA_CU_R|network|coolify|ok\nTUGRA_CU_DONE\n", SCAN_CLEAN) });
    const out = await t.svc.confirm("u1", v.id, { confirm: "olgu-box", listHash: v.listHash! });
    expect(out.status).toBe("CLEANING");
    await t.svc.settled(v.id);
    const done = await t.svc.get("u1", v.id);
    expect(done).toMatchObject({ status: "CLEANED", failureCode: null });
    expect(done.results).toEqual([{ kind: "container", name: "coolify-proxy", code: "ok" }, { kind: "network", name: "coolify", code: "ok" }]);
    expect(done.cleanedAt).not.toBeNull();
    expect(t.prisma.coolifyTakeover.updateMany).toHaveBeenCalledWith({ where: { serverId: "s1", giveBackAvailable: true }, data: { giveBackAvailable: false } });
    const removal = t.sent.find((s) => isRemoval(s.script))!;
    expect(removal.capability).toBe("coolify_cleanup");
    expect(removal.script).toContain("'coolify-proxy'");
    expect(t.caps.every((granted, i) => (i % 2 === 0 ? granted : !granted))).toBe(true);
    expect(t.caps[t.caps.length - 1]).toBe(false);
    expect(t.audits.map((a) => a.action)).toEqual(["coolify.cleanup.confirm", "coolify.cleanup.remove", "coolify.cleanup.remove", "coolify.cleanup.done"]);
    expect(t.audits[1].meta).toMatchObject({ kind: "container", name: "coolify-proxy", code: "ok" });
  });

  it("a removal that did not finish for an item ends FAILED (partial) and keeps 'give back' open", async () => {
    const { t, v } = await ready({ scripts: afterRemoval("TUGRA_CU_R|container|coolify-proxy|ok\nTUGRA_CU_R|network|coolify|in_use\nTUGRA_CU_DONE\n", "TUGRA_CU_BEGIN\nTUGRA_CU_N|coolify|1\nTUGRA_CU_END\n") });
    await t.svc.confirm("u1", v.id, { confirm: "olgu-box", listHash: v.listHash! });
    await t.svc.settled(v.id);
    expect(await t.svc.get("u1", v.id)).toMatchObject({ status: "FAILED", failureCode: "partial" });
    expect(t.prisma.coolifyTakeover.updateMany).not.toHaveBeenCalled();
  });

  it("something still removable after an all-ok removal is not CLEANED", async () => {
    const { t, v } = await ready({ scripts: afterRemoval("TUGRA_CU_R|container|coolify-proxy|ok\nTUGRA_CU_R|network|coolify|ok\nTUGRA_CU_DONE\n", SCAN_OK()) }); // the rescan still shows it
    await t.svc.confirm("u1", v.id, { confirm: "olgu-box", listHash: v.listHash! });
    await t.svc.settled(v.id);
    expect(await t.svc.get("u1", v.id)).toMatchObject({ status: "FAILED", failureCode: "partial" });
  });

  it("an agent that drops during the removal ends FAILED with a fixed code and the capability is still revoked", async () => {
    const { t, v } = await ready({ scripts: (script) => (isRemoval(script) ? new Error("socket closed") : { exitCode: 0, output: SCAN_OK() }) });
    await t.svc.confirm("u1", v.id, { confirm: "olgu-box", listHash: v.listHash! });
    await t.svc.settled(v.id);
    expect(await t.svc.get("u1", v.id)).toMatchObject({ status: "FAILED", failureCode: "agent_error" });
    expect(t.caps[t.caps.length - 1]).toBe(false);
  });

  it("a second confirm of the same cleanup loses the claim (409) and sends nothing", async () => {
    const { t, v } = await ready({ scripts: (script) => (isRemoval(script) ? { exitCode: 0, output: "TUGRA_CU_R|container|coolify-proxy|ok\nTUGRA_CU_R|network|coolify|ok\nTUGRA_CU_DONE\n" } : { exitCode: 0, output: SCAN_CLEAN }) });
    t.prisma.coolifyCleanup.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(t.svc.confirm("u1", v.id, { confirm: "olgu-box", listHash: v.listHash! })).rejects.toMatchObject({ response: expect.objectContaining({ code: "not_ready" }) });
    expect(t.sent.some((s) => isRemoval(s.script))).toBe(false);
  });

  it("a cleanup that is not READY (still checking, or already cleaned) cannot be confirmed", async () => {
    const { t, v } = await ready();
    t.rows.get(v.id)!.status = "CLEANED";
    await expect(t.svc.confirm("u1", v.id, { confirm: "olgu-box", listHash: v.listHash! })).rejects.toMatchObject({ response: expect.objectContaining({ code: "not_ready" }) });
  });
});

describe("no secret value is ever stored, audited or returned", () => {
  it("the variable values decrypted only to count names never reach a view, an audit row, a script or a stored row", async () => {
    const t = make({ scripts: afterRemoval("TUGRA_CU_R|container|coolify-proxy|ok\nTUGRA_CU_R|network|coolify|ok\nTUGRA_CU_DONE\n", SCAN_CLEAN) });
    const v = await t.svc.check("u1", "s1");
    await t.svc.confirm("u1", v.id, { confirm: "olgu-box", listHash: v.listHash! });
    await t.svc.settled(v.id);
    expect(t.crypto.decrypt).toHaveBeenCalled();
    const everything = JSON.stringify([await t.svc.get("u1", v.id), t.audits, t.sent, [...t.rows.values()]]);
    expect(everything).not.toContain(CANARY);
  });
});

describe("reads", () => {
  it("an owner or admin may read the newest cleanup; a plain member may not", async () => {
    const t = make();
    await t.svc.check("u1", "s1");
    t.access.teamRole.mockResolvedValue("ADMIN");
    expect((await t.svc.latest("u1", "s1"))?.status).toBe("READY");
    t.access.teamRole.mockResolvedValue("VIEWER");
    await expect(t.svc.latest("u1", "s1")).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("no cleanup yet is null", async () => {
    expect(await make().svc.latest("u1", "s1")).toBeNull();
  });
});

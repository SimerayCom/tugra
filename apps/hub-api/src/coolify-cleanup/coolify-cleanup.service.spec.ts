import { unwrapHostScript } from "../common/host-exec";
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { CoolifyCleanupService } from "./coolify-cleanup.service";
import { listHash } from "./remnant-scan";
import type { CoolifyInventoryData } from "../coolify-takeover/coolify-inventory";

const CANARY = "s3cr3t-canary-value-9f3a";
const SERVER = { id: "s1", teamId: "t1", name: "edge-box", publicIp: "203.0.113.10", publicIpv6: null, hostname: "box", reportedIps: [] as string[] };

const inventory = (over: Partial<CoolifyInventoryData> = {}): CoolifyInventoryData => ({
  v: 1,
  instance: { name: null, fqdn: null, ip: null, image: null },
  teams: [{ id: "1", name: "Team", description: null, personal: false, members: 1, notifications: [] }],
  servers: [
    { id: "0", uuid: "local", name: "localhost", description: null, ip: "10.0.0.1", port: 22, user: "root", teamId: "1", isLocal: true, reachable: true, usable: true, buildServer: false, swarm: false, keyName: null, apps: 0, databases: 0, services: 0 },
    { id: "5", uuid: "srv5", name: "northwind", description: null, ip: "203.0.113.10", port: 22, user: "root", teamId: "1", isLocal: false, reachable: true, usable: true, buildServer: false, swarm: false, keyName: null, apps: 1, databases: 0, services: 0 },
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
  /** What the public name resolves to (default: this server). */
  dnsA?: string[];
  /** Whether Tugra presents a valid certificate (default yes). */
  ssl?: boolean;
  /** When the stored Coolify read was taken (default: now). null = no time recorded. */
  readAt?: Date | null;
  dbs?: Array<Record<string, unknown>>;
  /** Guided runs that hold the server (MigrationRunServerLock rows). Default none. */
  locks?: number;
  /** Status of the server's newest takeover. Default: none. */
  takeover?: string | null;
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
    coolifyInventory: { findMany: jest.fn(async () => (inv ? [{ id: "i1", teamId: "t1", serverId: o.invServerId ?? "hub", snapshot: inv, serverLinks: o.links ?? {}, readAt: o.readAt === undefined ? new Date() : o.readAt }] : [])) },
    application: {
      findMany: jest.fn(async () => o.apps ?? [{ id: "a1", name: "blog", status: "RUNNING", envEnc: "ENC", domain: "blog.example.com", extraDomains: [], domainRedirect: null, volumes: volumesFixture, composeFile: null, domains: [] }]),
    },
    database: { findMany: jest.fn(async () => o.dbs ?? []) },
    notificationChannel: { findMany: jest.fn(async () => []) },
    scheduledTask: { findMany: jest.fn(async () => []) },
    bulkTask: { findMany: jest.fn(async () => []) },
    coolifyTakeover: { updateMany: jest.fn(async () => ({ count: 1 })), findFirst: jest.fn(async () => (o.takeover ? { status: o.takeover } : null)) },
    migrationRunServerLock: { count: jest.fn(async () => o.locks ?? 0) },
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
    sendCommand: jest.fn(async (_id: string, raw: string, capability: string) => {
      // /data/coolify is the HOST's: every script travels in the host namespaces; the specs read the script inside
      expect(raw).toContain("nsenter -t 1 -m");
      const script = unwrapHostScript(raw);
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
  const dns = { resolve4: jest.fn(async () => o.dnsA ?? ["203.0.113.10"]), resolve6: jest.fn(async () => [] as string[]) };
  const net = { sslAt: jest.fn(async () => ({ ok: o.ssl !== false })) };
  const svc = new CoolifyCleanupService(prisma as never, access as never, audit as never, agentWs as never, servers as never, crypto as never, dns as never, net as never);
  return { svc, prisma, access, audit, audits, agentWs, servers, caps, sent, calls, rows, crypto, dns, net };
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

  describe("a compose service Coolify runs several containers for", () => {
    const blog = { id: "a1", name: "blog", status: "RUNNING", envEnc: "ENC", domain: "blog.example.com", extraDomains: [], domainRedirect: null, volumes: [{ name: "data", path: "/data" }], composeFile: null, domains: [] };
    const twin = (services: string[]) => ({ id: "a2", name: "plausible", status: "RUNNING", envEnc: null, domain: null, extraDomains: [], domainRedirect: null, volumes: [], composeFile: `services:\n${services.map((x) => `  ${x}:\n    image: ${x}:1\n`).join("")}`, domains: [] });
    const withService = (components: number) =>
      inventory({ services: [{ id: "11", uuid: "uuidsvc01uuidsvc01uuidsv", name: "plausible", kind: null, components, envCount: 0, teamId: "1", projectId: null, environment: null, serverId: "5" } as never] });
    it("a Tugra twin with fewer containers than Coolify ran keeps the checklist closed and names the shortfall", async () => {
      const t = make({ inv: withService(2), apps: [blog, twin(["web"])] });
      const v = await t.svc.check("u1", "s1");
      expect(v.status).toBe("INCOMPLETE");
      expect(v.completeness.find((r) => r.kind === "service")?.missing).toEqual(["plausible (1/2 containers)"]);
      expect(t.sent.some((s) => isRemoval(s.script))).toBe(false);
    });
    it("a twin with every container counts as present", async () => {
      const t = make({ inv: withService(2), apps: [blog, twin(["web", "db"])] });
      const v = await t.svc.check("u1", "s1");
      expect(v.completeness.find((r) => r.kind === "service")).toMatchObject({ coolify: 1, tugra: 1, missing: [] });
      expect(v.status).toBe("READY");
    });
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

  it("a stored read older than the window (or with no time) is refused before anything runs", async () => {
    for (const readAt of [new Date(Date.now() - 31 * 60_000), null]) {
      const t = make({ readAt });
      await expect(t.svc.check("u1", "s1")).rejects.toMatchObject({ response: expect.objectContaining({ code: "read_stale" }) });
      expect([...t.rows.values()][0]).toMatchObject({ status: "FAILED", failureCode: "read_stale" });
      expect(t.agentWs.sendCommand).not.toHaveBeenCalled();
    }
  });

  it("traffic: a domain that still resolves to Coolify keeps the checklist INCOMPLETE and nothing removable is offered", async () => {
    const t = make({ dnsA: ["198.51.100.7"] });
    const v = await t.svc.check("u1", "s1");
    expect(v.status).toBe("INCOMPLETE");
    expect(v.completeness.find((r) => r.kind === "traffic")).toMatchObject({ coolify: 1, tugra: 0, missing: ["blog.example.com"] });
    expect(t.net.sslAt).not.toHaveBeenCalled();
  });

  it("traffic: Tugra without a valid certificate for the name is not cut over either", async () => {
    const t = make({ ssl: false });
    const v = await t.svc.check("u1", "s1");
    expect(v.status).toBe("INCOMPLETE");
    expect(v.completeness.find((r) => r.kind === "traffic")?.missing).toEqual(["blog.example.com"]);
    expect(t.net.sslAt).toHaveBeenCalledWith("203.0.113.10", "blog.example.com");
  });

  it("a database's data volume (postgres-data-<uuid>) is compared with the Tugra database's volumes", async () => {
    const DB = "uuiddb001uuiddb001uuiddb";
    const inv = inventory({ databases: [{ id: "3", uuid: DB, name: "main-db", type: "postgresql", image: null, status: "running:healthy", isPublic: false, teamId: "1", projectId: null, environment: null, serverId: "5" }] });
    const scans = (output: string) => ({ scripts: () => ({ exitCode: 0, output }) });
    const out = SCAN_OK([`TUGRA_CU_V|postgres-data-${DB}`, `TUGRA_CU_C|${DB}|postgres:16|running|true`]);
    const tdb = (volumes: unknown[]) => [{ id: "d1", name: "main-db", status: "RUNNING", backupEnabled: false, volumes }];
    const ok = await make({ inv, dbs: tdb([]), ...scans(out) }).svc.check("u1", "s1");
    const only = (r: typeof ok) => r.completeness.find((x) => x.kind === "volume")!;
    expect(only(ok)).toMatchObject({ coolify: 2, tugra: 2, missing: [] }); // the app's data volume and the database's engine data (Tugra's built-in "data") are compared
    expect(ok.status).toBe("READY");
    // a second volume Tugra does not have
    const extra = SCAN_OK([`TUGRA_CU_V|postgres-data-${DB}`, `TUGRA_CU_V|extra-vol-${DB}`]);
    const miss = await make({ inv, dbs: tdb([]), ...scans(extra) }).svc.check("u1", "s1");
    expect(only(miss).missing).toEqual(["main-db/extra-vol"]);
    expect(miss.status).toBe("INCOMPLETE");
  });

  it("a running database whose data volume the host does not show is unreadable: the checklist cannot be complete", async () => {
    const DB = "uuiddb001uuiddb001uuiddb";
    const inv = inventory({ databases: [{ id: "3", uuid: DB, name: "main-db", type: "postgresql", image: null, status: "running:healthy", isPublic: false, teamId: "1", projectId: null, environment: null, serverId: "5" }] });
    const t = make({ inv, dbs: [{ id: "d1", name: "main-db", status: "RUNNING", backupEnabled: false, volumes: [] }], scripts: () => ({ exitCode: 0, output: SCAN_OK([`TUGRA_CU_C|${DB}|postgres:16|running|true`]) }) });
    const v = await t.svc.check("u1", "s1");
    expect(v.completeness.find((r) => r.kind === "volume")?.unreadable).toBe(true);
    expect(v.status).toBe("INCOMPLETE");
  });

  it("a stopped Coolify container and directory of an item the checklist verified are removable; what the read does not know is kept", async () => {
    const UA = "uuidapp1uuidapp1uuidapp1";
    const OTHER = "zzzz9999yyyy8888xxxx7777"; // created in Coolify after the read
    const out = SCAN_OK([
      `TUGRA_CU_C|${UA}-170000|x|exited|true`,
      `TUGRA_CU_C|${OTHER}-170000|x|exited|true`,
      `TUGRA_CU_D|/data/coolify/applications/${UA}|4|plain`,
      `TUGRA_CU_D|/data/coolify/applications/${OTHER}|4|plain`,
      `TUGRA_CU_D|/data/coolify/services/${UA}|900|data`,
    ]);
    const v = await make({ scripts: () => ({ exitCode: 0, output: out }) }).svc.check("u1", "s1");
    const gone = v.remnants.filter((r) => !r.keep).map((r) => `${r.kind}:${r.name}`);
    expect(gone).toContain(`container:${UA}-170000`);
    expect(gone).toContain(`directory:/data/coolify/applications/${UA}`);
    expect(gone).not.toContain(`container:${OTHER}-170000`);
    expect(gone).not.toContain(`directory:/data/coolify/applications/${OTHER}`);
    expect(gone).not.toContain(`directory:/data/coolify/services/${UA}`);
  });

  it("an unreadable scan fails the check instead of reading as empty", async () => {
    const t = make({ scripts: () => ({ exitCode: 0, output: "TUGRA_CU_BEGIN\nTUGRA_CU_C|coolify-proxy|x|exited|true" }) });
    const v = await t.svc.check("u1", "s1");
    expect(v).toMatchObject({ status: "FAILED", failureCode: "scan_unreadable" });
  });

  it("a host that could not be entered (no agent image) is unreadable, not 'nothing left': the directories of /data/coolify are unknown, never empty", async () => {
    const t = make({ scripts: () => ({ exitCode: 1, output: "TUGRA_HOST_UNAVAILABLE reason=no-image\n" }) });
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

describe("CoolifyCleanupService: a server a takeover or a run still holds", () => {
  it("check is refused while a guided run holds the server (it may still undo or give back), before anything is created or read", async () => {
    const t = make({ locks: 1, takeover: "VERIFIED" });
    await expect(t.svc.check("u1", "s1")).rejects.toMatchObject({ response: expect.objectContaining({ code: "server_busy" }) });
    expect(t.prisma.coolifyCleanup.create).not.toHaveBeenCalled();
    expect(t.agentWs.sendCommand).not.toHaveBeenCalled();
  });
  it("check is refused unless the newest takeover is VERIFIED: planned, tested, swapped, being given back and failed ones still need Coolify", async () => {
    for (const status of ["PLANNED", "TESTING", "SWAPPING", "SWAPPED", "GIVING_BACK", "FAILED"]) {
      const t = make({ takeover: status });
      await expect(t.svc.check("u1", "s1")).rejects.toMatchObject({ response: expect.objectContaining({ code: "takeover_not_verified" }) });
      expect(t.agentWs.sendCommand).not.toHaveBeenCalled();
    }
  });
  it("no takeover (a copied server), a VERIFIED one and one that was given back (it holds nothing) may be checked", async () => {
    for (const takeover of [null, "VERIFIED", "GIVEN_BACK"]) {
      const t = make({ takeover });
      await expect(t.svc.check("u1", "s1")).resolves.toMatchObject({ status: "READY" });
    }
  });
  it("confirm looks again: a run or takeover that started after the check stops the removal before anything is removed", async () => {
    const t = make();
    const v = await t.svc.check("u1", "s1");
    t.sent.length = 0;
    t.prisma.migrationRunServerLock.count.mockResolvedValueOnce(1);
    await expect(t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! })).rejects.toMatchObject({ response: expect.objectContaining({ code: "server_busy" }) });
    t.prisma.coolifyTakeover.findFirst.mockResolvedValueOnce({ status: "SWAPPED" });
    await expect(t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! })).rejects.toMatchObject({ response: expect.objectContaining({ code: "takeover_not_verified" }) });
    expect(t.sent).toEqual([]);
    expect(t.rows.get(v.id)).toMatchObject({ status: "READY" });
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
    await expect(t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! })).rejects.toBeInstanceOf(ForbiddenException);
    t.access.teamRole.mockResolvedValue("OWNER");
    await expect(t.svc.confirm("u1", v.id, { confirm: "wrong", listHash: v.listHash! })).rejects.toBeInstanceOf(BadRequestException);
    expect(t.sent).toHaveLength(0);
  });

  it("a list hash that is not the one the owner saw is refused", async () => {
    const { t, v } = await ready();
    await expect(t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: "0".repeat(64) })).rejects.toMatchObject({ response: expect.objectContaining({ code: "list_changed" }) });
    expect(t.sent).toHaveLength(0);
  });

  it("an incomplete checklist can never be confirmed", async () => {
    const t = make({ apps: [] });
    const v = await t.svc.check("u1", "s1");
    await expect(t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash ?? "0".repeat(64) })).rejects.toMatchObject({ response: expect.objectContaining({ code: "incomplete" }) });
    expect(t.sent.some((s) => isRemoval(s.script))).toBe(false);
  });

  it("goes incomplete between the check and the confirm: refused, nothing removed", async () => {
    const { t, v } = await ready();
    t.prisma.application.findMany.mockResolvedValue([]);
    await expect(t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! })).rejects.toMatchObject({ response: expect.objectContaining({ code: "incomplete" }) });
    expect(t.sent.some((s) => isRemoval(s.script))).toBe(false);
    expect(t.rows.get(v.id)).toMatchObject({ status: "INCOMPLETE" });
  });

  it("the DNS check runs again at confirm: a domain moved back to Coolify since the check closes the checklist, nothing is removed", async () => {
    const { t, v } = await ready();
    t.dns.resolve4.mockResolvedValue(["198.51.100.7"]);
    await expect(t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! })).rejects.toMatchObject({ response: expect.objectContaining({ code: "incomplete" }) });
    expect(t.sent.some((s) => isRemoval(s.script))).toBe(false);
    expect(t.rows.get(v.id)).toMatchObject({ status: "INCOMPLETE" });
  });

  it("a stored read that became too old between the check and the confirm is refused, nothing is removed", async () => {
    const { t, v } = await ready();
    t.prisma.coolifyInventory.findMany.mockResolvedValue([{ id: "i1", teamId: "t1", serverId: "hub", snapshot: inventory(), serverLinks: {}, readAt: new Date(Date.now() - 2 * 3600_000) }] as never);
    await expect(t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! })).rejects.toMatchObject({ response: expect.objectContaining({ code: "read_stale" }) });
    expect(t.sent).toHaveLength(0);
  });

  it("the list changed on the host since the check: refused, the new list is stored for a second look", async () => {
    let calls = 0;
    const { t, v } = await ready({ scripts: () => ({ exitCode: 0, output: ++calls === 1 ? SCAN_OK() : SCAN_OK(["TUGRA_CU_C|coolify-sentinel|ghcr.io/coollabsio/sentinel:1|running|"]) }) });
    await expect(t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! })).rejects.toMatchObject({ response: expect.objectContaining({ code: "list_changed" }) });
    expect(t.sent.some((s) => isRemoval(s.script))).toBe(false);
    expect(t.rows.get(v.id)).toMatchObject({ status: "READY" });
  });

  it("removes exactly the confirmed list, verifies by a rescan, ends CLEANED and closes 'give back to Coolify'", async () => {
    const { t, v } = await ready({ scripts: afterRemoval("TUGRA_CU_R|container|coolify-proxy|ok\nTUGRA_CU_R|network|coolify|ok\nTUGRA_CU_DONE\n", SCAN_CLEAN) });
    const out = await t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! });
    expect(out.status).toBe("CLEANING");
    await t.svc.settled(v.id);
    const done = await t.svc.get("u1", v.id);
    expect(done).toMatchObject({ status: "CLEANED", failureCode: null });
    expect(done.results).toEqual([{ kind: "container", name: "coolify-proxy", code: "ok" }, { kind: "network", name: "coolify", code: "ok" }]);
    expect(done.cleanedAt).not.toBeNull();
    // only the finished takeover is closed: one that started on the server while this ran is not
    expect(t.prisma.coolifyTakeover.updateMany).toHaveBeenCalledWith({ where: { serverId: "s1", giveBackAvailable: true, status: "VERIFIED" }, data: { giveBackAvailable: false } });
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
    await t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! });
    await t.svc.settled(v.id);
    expect(await t.svc.get("u1", v.id)).toMatchObject({ status: "FAILED", failureCode: "partial" });
    expect(t.prisma.coolifyTakeover.updateMany).not.toHaveBeenCalled();
  });

  it("a directory freed only by the removed container is not removed in the same run: the run ends FAILED (recheck), never silently more than was confirmed", async () => {
    const UA = "uuidapp1uuidapp1uuidapp1";
    const before = SCAN_OK([`TUGRA_CU_C|${UA}-1|x|exited|true`, `TUGRA_CU_D|/data/coolify/applications/${UA}|4|plain`, `TUGRA_CU_M|${UA}-1|/data/coolify/applications/${UA}/c;`]);
    const afterRm = `TUGRA_CU_BEGIN\nTUGRA_CU_D|/data/coolify/applications/${UA}|4|plain\nTUGRA_CU_END\n`; // container gone, the directory is now free
    let removed = false;
    const { t, v } = await ready({ scripts: (script) => (isRemoval(script) ? ((removed = true), { exitCode: 0, output: `TUGRA_CU_R|container|${UA}-1|ok\nTUGRA_CU_R|container|coolify-proxy|ok\nTUGRA_CU_R|network|coolify|ok\nTUGRA_CU_DONE\n` }) : { exitCode: 0, output: removed ? afterRm : before }) });
    expect(v.remnants.find((r) => r.kind === "directory")).toMatchObject({ keep: true, reason: "in_use" });
    await t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! });
    await t.svc.settled(v.id);
    const removal = t.sent.find((x) => isRemoval(x.script))!;
    expect(removal.script).not.toContain(`applications/${UA}'`);
    expect(await t.svc.get("u1", v.id)).toMatchObject({ status: "FAILED", failureCode: "recheck" });
  });

  it("something still removable after an all-ok removal is not CLEANED", async () => {
    const { t, v } = await ready({ scripts: afterRemoval("TUGRA_CU_R|container|coolify-proxy|ok\nTUGRA_CU_R|network|coolify|ok\nTUGRA_CU_DONE\n", SCAN_OK()) }); // the rescan still shows it
    await t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! });
    await t.svc.settled(v.id);
    expect(await t.svc.get("u1", v.id)).toMatchObject({ status: "FAILED", failureCode: "partial" });
  });

  it("an agent that drops during the removal ends FAILED with a fixed code and the capability is still revoked", async () => {
    const { t, v } = await ready({ scripts: (script) => (isRemoval(script) ? new Error("socket closed") : { exitCode: 0, output: SCAN_OK() }) });
    await t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! });
    await t.svc.settled(v.id);
    expect(await t.svc.get("u1", v.id)).toMatchObject({ status: "FAILED", failureCode: "agent_error" });
    expect(t.caps[t.caps.length - 1]).toBe(false);
  });

  it("a second confirm of the same cleanup loses the claim (409) and sends nothing", async () => {
    const { t, v } = await ready({ scripts: (script) => (isRemoval(script) ? { exitCode: 0, output: "TUGRA_CU_R|container|coolify-proxy|ok\nTUGRA_CU_R|network|coolify|ok\nTUGRA_CU_DONE\n" } : { exitCode: 0, output: SCAN_CLEAN }) });
    t.prisma.coolifyCleanup.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! })).rejects.toMatchObject({ response: expect.objectContaining({ code: "not_ready" }) });
    expect(t.sent.some((s) => isRemoval(s.script))).toBe(false);
  });

  it("a cleanup that is not READY (still checking, or already cleaned) cannot be confirmed", async () => {
    const { t, v } = await ready();
    t.rows.get(v.id)!.status = "CLEANED";
    await expect(t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! })).rejects.toMatchObject({ response: expect.objectContaining({ code: "not_ready" }) });
  });
});

describe("no secret value is ever stored, audited or returned", () => {
  it("the variable values decrypted only to count names never reach a view, an audit row, a script or a stored row", async () => {
    const t = make({ scripts: afterRemoval("TUGRA_CU_R|container|coolify-proxy|ok\nTUGRA_CU_R|network|coolify|ok\nTUGRA_CU_DONE\n", SCAN_CLEAN) });
    const v = await t.svc.check("u1", "s1");
    await t.svc.confirm("u1", v.id, { confirm: "edge-box", listHash: v.listHash! });
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

import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Role, ServerStatus } from "@prisma/client";
import { HostMatchService } from "./host-match.service";
import { CoolifyTakeoverService, READ_MIN_INTERVAL_MS } from "./coolify-takeover.service";
import { fixtureOutput, SECTION_ROWS } from "./coolify-fixture";
import { buildInventory, parseRead } from "./coolify-inventory";
import { CFY } from "./coolify-read-script";

const SNAPSHOT = buildInventory(parseRead(fixtureOutput())).data;

interface Opts {
  roles?: Record<string, Role>;
  output?: string;
  optedIn?: boolean;
  snapshot?: unknown;
  readAt?: Date | null;
  links?: Record<string, { teamId: string; serverId: string }>;
  known?: Array<{ id: string; teamId: string; status?: ServerStatus; publicIp?: string | null; hostname?: string | null; reportedIps?: string[] }>;
}

function make(o: Opts = {}) {
  const roles = o.roles ?? { t1: Role.OWNER };
  const server = { id: "s1", teamId: "t1" };
  let row: Record<string, unknown> | null =
    o.optedIn === false
      ? null
      : { id: "inv1", teamId: "t1", serverId: "s1", enabledAt: new Date("2026-11-24T10:00:00Z"), readAt: o.readAt ?? null, coolifyImage: null, counts: null, snapshot: o.snapshot ?? null, serverLinks: o.links ?? {}, server: { name: "host-1" } };
  const access = {
    requireRole: jest.fn(async (_u: string, teamId: string, allowed: Role[]) => {
      const r = roles[teamId];
      if (!r || !allowed.includes(r)) throw new ForbiddenException("insufficient role for this team");
    }),
    roleByTeam: jest.fn(async () => new Map(Object.entries(roles))),
    // owners and admins hold servers:manage; a viewer does not
    permissionsByTeam: jest.fn(async () => new Map(Object.entries(roles).map(([t, r]) => [t, new Set(r === Role.VIEWER ? [] : ["servers:manage"])]))),
    teamIds: jest.fn(async () => Object.keys(roles)),
  };
  const made: Array<{ id: string; teamId: string; status: ServerStatus }> = [];
  const prisma = {
    server: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === "s1" ? server : null)),
      findMany: jest.fn(async () => [...(o.known ?? []), ...made].map((k) => ({ status: ServerStatus.ONLINE, publicIp: null, publicIpv6: null, hostname: null, reportedIps: [], ...k }))),
    },
    team: { findMany: jest.fn(async () => Object.keys(roles).map((id) => ({ id, name: id === "t1" ? "Acme" : id }))) },
    coolifyInventory: {
      findMany: jest.fn(async () => (row ? [row] : [])),
      findUnique: jest.fn(async () => row),
      upsert: jest.fn(async () => {
        row = row ?? { id: "inv1", teamId: "t1", serverId: "s1", enabledAt: new Date(), readAt: null, coolifyImage: null, counts: null, snapshot: null, serverLinks: {}, server: { name: "host-1" } };
        return row;
      }),
      deleteMany: jest.fn(async () => {
        row = null;
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...row!, ...data };
        return row;
      }),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (!row) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      }),
      findUniqueOrThrow: jest.fn(async () => row),
    },
  };
  const audit = { log: jest.fn() };
  const sendCommand = jest.fn(async (..._a: unknown[]) => ({ exitCode: 0, output: o.output ?? fixtureOutput() }));
  const agentWs = { sendCommand };
  let n = 0;
  const servers = {
    createServersBulk: jest.fn(async (_u: string, names: string[], teamId: string) => ({
      servers: names.map((name) => {
        const server = { id: `new${++n}`, name, teamId };
        made.push({ id: server.id, teamId, status: ServerStatus.PENDING });
        return { server };
      }),
    })),
    hostIdentityOf: jest.fn(() => undefined),
    getInstall: jest.fn(async (_u: string, id: string) => ({ status: ServerStatus.PENDING, installCommand: `curl https://hub.example.com/install/agent.sh | sh -s -- --token tok-${id}`, expiresAt: new Date("2026-11-24T12:00:00Z") })),
  };
  const svc = new CoolifyTakeoverService(prisma as never, access as never, audit as never, agentWs as never, servers as never, new HostMatchService(prisma as never, access as never, servers as never));
  return { svc, access, prisma, audit, sendCommand, servers, getRow: () => row };
}

describe("access: owner/admin only, explicit opt-in", () => {
  it.each([Role.VIEWER])("refuses a %s everywhere before anything reaches the agent", async (role) => {
    const { svc, sendCommand, prisma } = make({ roles: { t1: role } });
    await expect(svc.detect("u", "s1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.enable("u", "s1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.read("u", "s1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.get("u", "s1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.disable("u", "s1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.list("u", "t1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.checklist("u", "s1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.generate("u", "s1", { assignments: [{ coolifyServerId: "1", teamId: "t1" }] })).rejects.toBeInstanceOf(ForbiddenException);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(prisma.coolifyInventory.upsert).not.toHaveBeenCalled();
  });

  it("refuses a member of another team (the server's team decides)", async () => {
    const { svc, sendCommand } = make({ roles: { t9: Role.OWNER } });
    await expect(svc.read("u", "s1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("404s an unknown server", async () => {
    const { svc } = make();
    await expect(svc.enable("u", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("will not read a server that was not opted in", async () => {
    const { svc, sendCommand } = make({ optedIn: false });
    const err = await svc.read("u", "s1").catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code: "not_enabled" });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("an admin can opt in; the opt-in is audited", async () => {
    const { svc, audit } = make({ roles: { t1: Role.ADMIN }, optedIn: false });
    const v = await svc.enable("u", "s1");
    expect(v.serverId).toBe("s1");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ actor: "u", action: "coolify.takeover.enable", target: "s1" }));
  });
});

describe("read", () => {
  it("runs the read script under the database capability, stores the inventory and audits counts only", async () => {
    const { svc, sendCommand, audit, getRow } = make();
    const v = await svc.read("u", "s1");
    expect(sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("coolify-db"), "database", expect.any(Number), expect.any(Function));
    expect(v.data?.servers).toHaveLength(3);
    expect(v.counts).toMatchObject({ applications: 1, databases: 2 });
    expect(v.coolifyImage).toContain("coolify:4.0.0-beta.999");
    expect(getRow()!.readById).toBe("u");
    const entry = audit.log.mock.calls.map((c) => c[0]).find((e) => e.action === "coolify.takeover.read");
    expect(entry).toMatchObject({ actor: "u", target: "s1", meta: expect.objectContaining({ applications: 1 }) });
    expect(JSON.stringify(entry)).not.toContain("example.com");
  });

  it("a second read inside the throttle window returns the stored inventory without touching the host", async () => {
    const { svc, sendCommand } = make({ snapshot: SNAPSHOT, readAt: new Date(Date.now() - READ_MIN_INTERVAL_MS / 2) });
    const v = await svc.read("u", "s1");
    expect(sendCommand).not.toHaveBeenCalled();
    expect(v.data?.servers).toHaveLength(3);
  });

  it("joins a read that is already running", async () => {
    const { svc, sendCommand } = make();
    const [a, b] = await Promise.all([svc.read("u", "s1"), svc.read("u", "s1")]);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(a.data?.servers).toHaveLength(b.data?.servers.length ?? -1);
  });

  it.each([
    [CFY.noCoolify, "no_coolify"],
    [CFY.noDocker, "no_docker"],
    [CFY.stopped, "db_stopped"],
    [fixtureOutput({ ro: "off" }), "not_read_only"],
  ])("answers a typed 400 for %#", async (output, code) => {
    const { svc, audit, getRow } = make({ output });
    const err = await svc.read("u", "s1").catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code });
    expect(getRow()!.snapshot).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.read_failed", meta: { failure: code } }));
  });
});

describe("detect / disable", () => {
  it("detect reports whether Coolify runs here and the version, reading nothing from the database", async () => {
    const { svc, sendCommand } = make({ output: `${CFY.image}ghcr.io/coollabsio/coolify:4.0.0-beta.1\n${CFY.done}` });
    expect(await svc.detect("u", "s1")).toEqual({ found: true, image: "ghcr.io/coollabsio/coolify:4.0.0-beta.1" });
    expect(sendCommand.mock.calls[0][1]).not.toContain("psql");
  });

  it("detect says not found when there is no coolify-db", async () => {
    const { svc } = make({ output: CFY.noCoolify });
    expect(await svc.detect("u", "s1")).toEqual({ found: false, image: null });
  });

  it("disable removes the opt-in and what was read, and audits it", async () => {
    const { svc, getRow, audit } = make({ snapshot: SNAPSHOT });
    await svc.disable("u", "s1");
    expect(getRow()).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.disable" }));
  });
});

describe("checklist and generate (nothing runs)", () => {
  it("needs a read first", async () => {
    const { svc } = make();
    await expect(svc.generate("u", "s1", { assignments: [{ coolifyServerId: "1", teamId: "t1" }] })).rejects.toBeInstanceOf(ConflictException);
  });

  it("lists the Coolify host as covered and the others as not generated, with a default team", async () => {
    const { svc } = make({ snapshot: SNAPSHOT });
    const view = await svc.checklist("u", "s1");
    expect(view.rows.map((r) => [r.name, r.state])).toEqual([["localhost", "this_server"], ["edge", "not_generated"], ["builder", "not_generated"]]);
    expect(view.rows[1]).toMatchObject({ teamId: "t1", ssh: "ssh -p 2222 deploy@198.51.100.7" });
    expect(view.teams).toEqual([{ id: "t1", name: "Acme" }]);
  });

  it("creates one pending Tugra server per chosen Coolify server (per target team) and returns the commands", async () => {
    const { svc, servers, getRow, audit } = make({ snapshot: SNAPSHOT, roles: { t1: Role.OWNER, t2: Role.ADMIN } });
    const view = await svc.generate("u", "s1", { assignments: [{ coolifyServerId: "1", teamId: "t1" }, { coolifyServerId: "2", teamId: "t2" }] }, "https://hub.example.com");
    expect(servers.createServersBulk).toHaveBeenCalledWith("u", ["edge"], "t1", "https://hub.example.com");
    expect(servers.createServersBulk).toHaveBeenCalledWith("u", ["builder"], "t2", "https://hub.example.com");
    expect(Object.keys(getRow()!.serverLinks as object).sort()).toEqual(["1", "2"]);
    const edge = view.rows.find((r) => r.name === "edge")!;
    expect(edge).toMatchObject({ state: "waiting", teamId: "t1" });
    expect(edge.installCommand).toContain("install/agent.sh");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.servers_generate", meta: { created: 2, adopted: 0 } }));
  });

  it("never creates the Coolify host again, and is safe to repeat", async () => {
    const { svc, servers } = make({ snapshot: SNAPSHOT });
    await svc.generate("u", "s1", { assignments: [{ coolifyServerId: "0", teamId: "t1" }, { coolifyServerId: "1", teamId: "t1" }] });
    expect(servers.createServersBulk).toHaveBeenCalledTimes(1);
    expect(servers.createServersBulk.mock.calls[0][1]).toEqual(["edge"]);
    await svc.generate("u", "s1", { assignments: [{ coolifyServerId: "1", teamId: "t1" }] });
    expect(servers.createServersBulk).toHaveBeenCalledTimes(1);
  });

  it("links a Coolify server to a Tugra server that already sits at its address instead of creating a duplicate", async () => {
    const { svc, servers, getRow, audit } = make({ snapshot: SNAPSHOT, known: [{ id: "existing", teamId: "t1", publicIp: "198.51.100.7" }] });
    const view = await svc.generate("u", "s1", { assignments: [{ coolifyServerId: "1", teamId: "t1" }] });
    expect(servers.createServersBulk).not.toHaveBeenCalled();
    // stored with how it was linked and why (the evidence kinds only, no address)
    expect(getRow()!.serverLinks).toEqual({ "1": { teamId: "t1", serverId: "existing", linkedBy: "auto", evidence: [{ kind: "ip", equal: true }] } });
    expect(JSON.stringify(getRow()!.serverLinks)).not.toContain("198.51.100");
    expect(view.rows.find((r) => r.name === "edge")).toMatchObject({ state: "already_added", tugraServerId: "existing" });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ meta: { created: 0, adopted: 1 } }));
  });

  it("marks an already-added row that is matched only by an address as probable, so the owner can check it", async () => {
    const { svc } = make({ snapshot: SNAPSHOT, known: [{ id: "existing", teamId: "t1", publicIp: "198.51.100.7" }] });
    const row = (await svc.checklist("u", "s1")).rows.find((r) => r.name === "edge")!;
    expect(row).toMatchObject({ state: "already_added", tugraServerId: "existing", probable: true });
    // the same after the hub stored its own address-based link
    const links = { "1": { teamId: "t1", serverId: "existing", linkedBy: "auto" } };
    const again = make({ snapshot: SNAPSHOT, links, known: [{ id: "existing", teamId: "t1", publicIp: "198.51.100.7" }] });
    expect((await again.svc.checklist("u", "s1")).rows.find((r) => r.name === "edge")).toMatchObject({ state: "already_added", probable: true });
  });

  it("does not offer the check for a link the owner made, or for a server that is not matched at all", async () => {
    const links = { "1": { teamId: "t1", serverId: "existing", linkedBy: "user" } };
    const { svc } = make({ snapshot: SNAPSHOT, links, known: [{ id: "existing", teamId: "t1", publicIp: "198.51.100.7" }] });
    const rows = (await svc.checklist("u", "s1")).rows;
    expect(rows.find((r) => r.name === "edge")?.probable).toBeUndefined();
    const plain = make({ snapshot: SNAPSHOT });
    expect((await plain.svc.checklist("u", "s1")).rows.every((r) => r.probable === undefined)).toBe(true);
  });

  it("a host name alone never links: it is a weak clue, so the owner picks (and nothing is created either)", async () => {
    const named = { ...SNAPSHOT, servers: SNAPSHOT.servers.map((x) => (x.id === "1" ? { ...x, ip: "edge.example.com" } : x)) };
    const { svc, servers, getRow } = make({ snapshot: named, known: [{ id: "named", teamId: "t1", hostname: "edge.example.com" }] });
    const view = await svc.generate("u", "s1", { assignments: [{ coolifyServerId: "1", teamId: "t1" }] });
    expect(getRow()!.serverLinks).toEqual({});
    expect(servers.createServersBulk).not.toHaveBeenCalled();
    expect(view.rows.find((r) => r.name === "edge")?.state).toBe("ambiguous");
  });

  it("a server the caller cannot manage (a viewer team) is never auto-linked", async () => {
    const { svc, getRow } = make({ snapshot: SNAPSHOT, known: [{ id: "theirs", teamId: "t2", publicIp: "198.51.100.7" }], roles: { t1: Role.OWNER, t2: Role.VIEWER } });
    await svc.generate("u", "s1", { assignments: [{ coolifyServerId: "1", teamId: "t1" }] });
    expect(JSON.stringify(getRow()!.serverLinks)).not.toContain("theirs");
  });

  it("servers it creates are linked as the user's own, and a link stored before linkedBy existed reads as the user's", async () => {
    const { svc, getRow } = make({ snapshot: SNAPSHOT });
    await svc.generate("u", "s1", { assignments: [{ coolifyServerId: "1", teamId: "t1" }] });
    expect(Object.values(getRow()!.serverLinks as Record<string, { linkedBy: string }>).every((l) => l.linkedBy === "user")).toBe(true);
    const old = make({ snapshot: SNAPSHOT, links: { "1": { teamId: "t1", serverId: "p1" } } });
    await old.svc.generate("u", "s1", { assignments: [{ coolifyServerId: "2", teamId: "t1" }] });
    expect((old.getRow()!.serverLinks as Record<string, unknown>)["1"]).toEqual({ teamId: "t1", serverId: "p1", linkedBy: "user" });
  });

  it("does not tie a Coolify server to a Tugra server that only shares a private address with it", async () => {
    const { svc, servers } = make({ snapshot: SNAPSHOT, known: [{ id: "other", teamId: "t1", publicIp: "203.0.113.50", reportedIps: ["10.0.0.9"] }] });
    const view = await svc.checklist("u", "s1");
    expect(view.rows.find((r) => r.name === "edge")?.state).toBe("not_generated");
    expect(servers.createServersBulk).not.toHaveBeenCalled();
  });

  it("matches nothing and creates nothing when two Tugra servers sit at the address, and says so", async () => {
    const known = [{ id: "a", teamId: "t1", publicIp: "198.51.100.7" }, { id: "b", teamId: "t2", publicIp: "198.51.100.7" }];
    const { svc, servers, getRow, audit } = make({ snapshot: SNAPSHOT, known, roles: { t1: Role.OWNER, t2: Role.ADMIN } });
    expect((await svc.checklist("u", "s1")).rows.find((r) => r.name === "edge")).toMatchObject({ state: "ambiguous", tugraServerId: null });
    const view = await svc.generate("u", "s1", { assignments: [{ coolifyServerId: "1", teamId: "t1" }] });
    expect(servers.createServersBulk).not.toHaveBeenCalled();
    expect(getRow()!.serverLinks).toEqual({});
    expect(view.rows.find((r) => r.name === "edge")?.state).toBe("ambiguous");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ meta: { created: 0, adopted: 0, ambiguous: 1 } }));
  });

  it("rejects a server that is not in the inventory, and a target team without servers:manage", async () => {
    const { svc, servers } = make({ snapshot: SNAPSHOT });
    await expect(svc.generate("u", "s1", { assignments: [{ coolifyServerId: "99", teamId: "t1" }] })).rejects.toBeInstanceOf(BadRequestException);
    servers.createServersBulk.mockRejectedValueOnce(new ForbiddenException("insufficient permission for this team"));
    await expect(svc.generate("u", "s1", { assignments: [{ coolifyServerId: "1", teamId: "t9" }] })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("shows an expired command as expired, and a connected server as added", async () => {
    const links = { "1": { teamId: "t1", serverId: "p1" }, "2": { teamId: "t1", serverId: "p2" } };
    const known = [{ id: "p1", teamId: "t1", status: ServerStatus.PENDING }, { id: "p2", teamId: "t1", status: ServerStatus.ONLINE }];
    const { svc, servers } = make({ snapshot: SNAPSHOT, links, known });
    servers.getInstall.mockResolvedValueOnce({ status: ServerStatus.PENDING, installCommand: null as never, expiresAt: new Date() });
    const view = await svc.checklist("u", "s1");
    expect(view.rows.map((r) => r.state)).toEqual(["this_server", "expired", "already_added"]);
  });

  it("the stored/served inventory carries no secret value", async () => {
    const { svc } = make({ snapshot: SNAPSHOT });
    const text = JSON.stringify(await svc.get("u", "s1"));
    for (const k of ["private_key", "password", "webhook_url"]) expect(text).not.toContain(k);
    expect(SECTION_ROWS).toBeDefined();
  });
});

describe("hardening", () => {
  it("audits a read that never got an answer (agent offline / timeout)", async () => {
    const { svc, sendCommand, audit } = make();
    sendCommand.mockRejectedValueOnce(new Error("offline"));
    await expect(svc.read("u", "s1")).rejects.toThrow("offline");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.read_failed", meta: { failure: "Error" } }));
  });

  it("audits a failed detect too", async () => {
    const { svc, sendCommand, audit } = make();
    sendCommand.mockRejectedValueOnce(new Error("offline"));
    await expect(svc.detect("u", "s1")).rejects.toThrow("offline");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.detect", meta: { failure: "Error" } }));
  });

  it("answers 409, not 500, and stores nothing when the opt-in is withdrawn during the read", async () => {
    const { svc, sendCommand, getRow } = make();
    sendCommand.mockImplementationOnce(async () => {
      await svc.disable("u", "s1");
      return { exitCode: 0, output: fixtureOutput() };
    });
    await expect(svc.read("u", "s1")).rejects.toBeInstanceOf(ConflictException);
    expect(getRow()).toBeNull();
  });

  it("serializes concurrent generate calls: one Tugra server per Coolify server", async () => {
    const { svc, servers } = make({ snapshot: SNAPSHOT });
    const remote = SNAPSHOT.servers.find((s) => !s.isLocal)!;
    const input = { assignments: [{ coolifyServerId: remote.id, teamId: "t1" }] };
    const [a, b] = await Promise.all([svc.generate("u", "s1", input), svc.generate("u", "s1", input)]);
    const created = servers.createServersBulk.mock.calls.reduce((n, c) => n + (c[1] as string[]).length, 0);
    expect(created).toBe(1);
    expect(a.rows.find((r) => r.coolifyServerId === remote.id)?.tugraServerId).toBe(b.rows.find((r) => r.coolifyServerId === remote.id)?.tugraServerId);
  });

  it("shows no_access (not expired) when the caller cannot manage the linked server's team", async () => {
    const remote = SNAPSHOT.servers.find((s) => !s.isLocal)!;
    const { svc, servers } = make({
      snapshot: SNAPSHOT,
      links: { [remote.id]: { teamId: "t1", serverId: "p1" } },
      known: [{ id: "p1", teamId: "t1", status: ServerStatus.PENDING }],
    });
    servers.getInstall.mockRejectedValueOnce(new ForbiddenException("no"));
    const view = await svc.checklist("u", "s1");
    expect(view.rows.find((r) => r.coolifyServerId === remote.id)?.state).toBe("no_access");
  });
});

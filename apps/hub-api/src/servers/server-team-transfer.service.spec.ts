import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ServerTeamTransferService, TRANSFER_BLOCKED_CODE, type TransferBlocker } from "./server-team-transfer.service";
import { TeamAccessService } from "../common/team-access.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../audit/audit.service";
import type { ServersService } from "./servers.service";

type Rows = Record<string, unknown>;

const SERVER = {
  id: "srv1",
  name: "app-1",
  teamId: "teamA",
  clusterId: null as string | null,
  swarmRole: null,
  cloudCredentialId: null as string | null,
  dnsCredentialId: null as string | null,
  dnsCredsEnc: null as string | null,
};

/** A table delegate: count/findMany resolve from a fixed row list (the where is recorded, not interpreted). */
function table(rows: Rows[] = []) {
  return { count: jest.fn().mockResolvedValue(rows.length), findMany: jest.fn().mockResolvedValue(rows), findUnique: jest.fn() };
}

interface World {
  user?: { isInstanceOwner: boolean } | null;
  /** userId-agnostic membership rows keyed by teamId. */
  memberships?: Record<string, { role: Role; teamRole?: { permissions: string[] } | null }>;
  server?: typeof SERVER | null;
  teams?: Record<string, string>; // id -> name
  blockers?: Partial<Record<"application" | "database" | "monitor" | "appMove" | "migrationRun" | "objectMigration" | "serverReboot" | "serverTunnel" | "logDrain" | "bulkTask", Rows[]>>;
  lockCount?: number;
  autoMonitors?: { id: string }[];
  channelLinks?: number;
  updateCount?: number;
}

function build(w: World = {}) {
  const server = w.server === undefined ? { ...SERVER } : w.server;
  const teams = w.teams ?? { teamA: "Acme", teamB: "Beta" };
  const b = w.blockers ?? {};
  const tx = {
    server: { updateMany: jest.fn().mockResolvedValue({ count: w.updateCount ?? 1 }) },
    // One table serves the blocker scan (auto=false) and the in-transaction re-homing of the auto monitor (auto=true).
    monitor: {
      count: jest.fn().mockResolvedValue((b.monitor ?? []).length),
      findMany: jest.fn(({ where }: { where: { auto: boolean } }) => Promise.resolve(where.auto ? (w.autoMonitors ?? []) : (b.monitor ?? []))),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    monitorChannel: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), count: jest.fn().mockResolvedValue(w.channelLinks ?? 0) },
    application: table(b.application),
    database: table(b.database),
    cluster: { findUnique: jest.fn().mockResolvedValue({ id: "c1", name: "edge" }) },
    appMove: table(b.appMove),
    migrationRun: table(b.migrationRun),
    migrationRunServerLock: { count: jest.fn().mockResolvedValue(w.lockCount ?? 0) },
    objectMigration: table(b.objectMigration),
    serverReboot: table(b.serverReboot),
    serverTunnel: table(b.serverTunnel),
    logDrain: table(b.logDrain),
    bulkTask: table(b.bulkTask),
  };
  const prisma = {
    ...tx,
    user: { findUnique: jest.fn().mockResolvedValue(w.user === undefined ? { isInstanceOwner: false } : w.user) },
    membership: {
      findUnique: jest.fn(({ where }: { where: { userId_teamId: { teamId: string } } }) => Promise.resolve(w.memberships?.[where.userId_teamId.teamId] ?? null)),
      findMany: jest.fn().mockResolvedValue(
        Object.entries(w.memberships ?? {}).map(([teamId, m]) => ({ teamId, role: m.role, teamRole: m.teamRole ?? null })),
      ),
    },
    team: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(teams[where.id] ? { id: where.id, name: teams[where.id] } : null)),
      findMany: jest.fn(({ where }: { where: { id: { not: string; in?: string[] } } }) =>
        Promise.resolve(
          Object.entries(teams)
            .filter(([id]) => id !== where.id.not && (!where.id.in || where.id.in.includes(id)))
            .map(([id, name]) => ({ id, name })),
        ),
      ),
    },
    server: {
      findUnique: jest.fn().mockResolvedValue(server),
      updateMany: tx.server.updateMany,
    },
    cloudCredential: { findUnique: jest.fn().mockResolvedValue({ name: "Provider key" }) },
    dnsCredential: { findUnique: jest.fn().mockResolvedValue({ name: "Edge DNS" }) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const servers = { emitTeamChanged: jest.fn() };
  const svc = new ServerTeamTransferService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    new TeamAccessService(prisma as unknown as PrismaService),
    servers as unknown as ServersService,
  );
  return { svc, prisma, tx, audit, servers };
}

const admin = { role: Role.ADMIN };
const viewer = { role: Role.VIEWER };
const both = { memberships: { teamA: admin, teamB: admin } };

describe("ServerTeamTransferService authorization", () => {
  it("moves when the actor manages servers in BOTH teams", async () => {
    const { svc, tx, audit, servers } = build(both);
    await expect(svc.transfer("u1", "srv1", "teamB")).resolves.toEqual({ serverId: "srv1", fromTeamId: "teamA", toTeamId: "teamB" });
    expect(tx.server.updateMany).toHaveBeenCalledWith({
      where: { id: "srv1", teamId: "teamA" },
      data: { teamId: "teamB", clusterId: null, cloudCredentialId: null, dnsCredentialId: null },
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ actor: "u1", action: "server.team.change", target: "srv1", meta: { fromTeamId: "teamA", toTeamId: "teamB" } }));
    expect(servers.emitTeamChanged).toHaveBeenCalledWith("srv1");
  });

  it("refuses when the actor only manages the OLD team", async () => {
    const { svc, tx } = build({ memberships: { teamA: admin, teamB: viewer } });
    await expect(svc.transfer("u1", "srv1", "teamB")).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.server.updateMany).not.toHaveBeenCalled();
  });

  it("refuses when the actor only manages the NEW team", async () => {
    const { svc } = build({ memberships: { teamA: viewer, teamB: admin } });
    await expect(svc.transfer("u1", "srv1", "teamB")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a custom role needs servers:manage specifically", async () => {
    const readOnly = { role: Role.VIEWER, teamRole: { permissions: ["apps:config"] } };
    const { svc } = build({ memberships: { teamA: admin, teamB: readOnly } });
    await expect(svc.transfer("u1", "srv1", "teamB")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("answers 403 for a destination the actor is not in, existing or not (no team-id probing)", async () => {
    const real = build({ memberships: { teamA: admin } });
    await expect(real.svc.transfer("u1", "srv1", "teamB")).rejects.toBeInstanceOf(ForbiddenException);
    const ghost = build({ memberships: { teamA: admin } });
    await expect(ghost.svc.transfer("u1", "srv1", "nope")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("the instance owner may move without being a member of either team", async () => {
    const { svc, tx } = build({ user: { isInstanceOwner: true }, memberships: {} });
    await svc.transfer("owner", "srv1", "teamB");
    expect(tx.server.updateMany).toHaveBeenCalled();
  });

  it("the instance owner still gets 404 for an unknown destination team", async () => {
    const { svc } = build({ user: { isInstanceOwner: true } });
    await expect(svc.transfer("owner", "srv1", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404 for an unknown server, 400 for the same team", async () => {
    await expect(build({ ...both, server: null }).svc.transfer("u1", "x", "teamB")).rejects.toBeInstanceOf(NotFoundException);
    await expect(build(both).svc.transfer("u1", "srv1", "teamA")).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("ServerTeamTransferService blockers", () => {
  const blockerKinds = (e: unknown) => ((e as ConflictException).getResponse() as { blockers: TransferBlocker[] }).blockers.map((b) => b.kind);

  it("blocks with a clear list of apps and databases and never writes", async () => {
    const { svc, tx, audit, servers } = build({
      ...both,
      blockers: { application: [{ id: "a1", name: "web" }, { id: "a2", name: "api" }], database: [{ id: "d1", name: "pg" }] },
    });
    const err = await svc.transfer("u1", "srv1", "teamB").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: TRANSFER_BLOCKED_CODE });
    const blockers = (err.getResponse() as { blockers: TransferBlocker[] }).blockers;
    expect(blockers).toEqual([
      { kind: "application", count: 2, items: [{ id: "a1", name: "web" }, { id: "a2", name: "api" }] },
      // the build-server scan shares the app table mock, so it reports the same rows — only kinds matter to the contract
      { kind: "build_server", count: 2, items: [{ id: "a1", name: "web" }, { id: "a2", name: "api" }] },
      { kind: "database", count: 1, items: [{ id: "d1", name: "pg" }] },
    ]);
    expect(tx.server.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(servers.emitTeamChanged).not.toHaveBeenCalled();
  });

  it("blocks on a hand-made monitor, a cluster membership, a live app move, a migration and a reboot", async () => {
    const { svc } = build({
      ...both,
      server: { ...SERVER, clusterId: "c1" },
      blockers: { monitor: [{ id: "m1", name: "cpu" }], appMove: [{ id: "mv1" }], migrationRun: [{ id: "r1" }], serverReboot: [{ id: "rb1" }] },
      lockCount: 1,
    });
    const err = await svc.transfer("u1", "srv1", "teamB").catch((e) => e);
    expect(blockerKinds(err)).toEqual(["monitor", "cluster", "app_move", "migration", "reboot"]);
  });

  it("blocks on a Cloudflare tunnel, a server-wide log drain and a running importer task", async () => {
    const { svc, tx } = build({
      ...both,
      blockers: { serverTunnel: [{ id: "t1" }], logDrain: [{ id: "l1", name: "ship" }], bulkTask: [{ id: "bt1" }] },
    });
    const err = await svc.transfer("u1", "srv1", "teamB").catch((e) => e);
    expect(blockerKinds(err)).toEqual(["tunnel", "log_drain", "bulk_task"]);
    expect(tx.server.updateMany).not.toHaveBeenCalled();
    // only server-wide drains (appId null) and live non-command importer tasks count
    expect(tx.logDrain.count).toHaveBeenCalledWith({ where: { serverId: "srv1", appId: null } });
    expect(tx.bulkTask.count).toHaveBeenCalledWith({ where: { serverId: "srv1", status: { in: ["PENDING", "RUNNING"] }, kind: { not: "command" } } });
  });

  it("scans only hand-made monitors (auto=false) so the auto disk monitor never blocks", async () => {
    const { svc, tx } = build(both);
    await svc.transfer("u1", "srv1", "teamB");
    expect(tx.monitor.count).toHaveBeenCalledWith({ where: { serverId: "srv1", auto: false } });
  });

  it("re-scans inside the transaction: a resource created after the preview still blocks", async () => {
    const { svc, tx } = build(both);
    // Preview scan is clean; by the time the transaction runs an app appeared.
    tx.application.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0); // preview (application + build_server)
    tx.application.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    tx.application.count.mockResolvedValueOnce(1);
    tx.application.findMany.mockResolvedValueOnce([{ id: "late", name: "late-app" }]);
    const err = await svc.transfer("u1", "srv1", "teamB").catch((e) => e);
    expect(blockerKinds(err)).toEqual(["application"]);
    expect(tx.server.updateMany).not.toHaveBeenCalled();
  });

  it("409 when a racing move already changed the server's team", async () => {
    const { svc } = build({ ...both, updateCount: 0 });
    await expect(svc.transfer("u1", "srv1", "teamB")).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("ServerTeamTransferService side effects", () => {
  it("re-homes the auto disk monitor and drops the old team's alert channels", async () => {
    const { svc, tx } = build({ ...both, autoMonitors: [{ id: "m-auto" }] });
    await svc.transfer("u1", "srv1", "teamB");
    expect(tx.monitorChannel.deleteMany).toHaveBeenCalledWith({ where: { monitorId: { in: ["m-auto"] } } });
    expect(tx.monitor.updateMany).toHaveBeenCalledWith({ where: { serverId: "srv1", auto: true }, data: { teamId: "teamB" } });
  });

  it("leaves monitors alone when the server has no auto monitor", async () => {
    const { svc, tx } = build(both);
    await svc.transfer("u1", "srv1", "teamB");
    expect(tx.monitor.updateMany).not.toHaveBeenCalled();
  });

  it("runs the move in a serializable transaction", async () => {
    const { svc, prisma } = build(both);
    await svc.transfer("u1", "srv1", "teamB");
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("records the dropped provider links in the audit entry", async () => {
    const { svc, audit } = build({ ...both, server: { ...SERVER, cloudCredentialId: "cc1", dnsCredentialId: "dc1" }, channelLinks: 2 });
    await svc.transfer("u1", "srv1", "teamB");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ meta: { fromTeamId: "teamA", toTeamId: "teamB", detached: ["cloud_credential", "dns_credential", "alert_channels"] } }));
  });
});

describe("ServerTeamTransferService DNS-01 secret", () => {
  const withSecret = { ...both, server: { ...SERVER, dnsCredsEnc: "enc-blob" } };

  it("wipes the copied DNS-01 token, provider and wildcard policy in the same write and reports it", async () => {
    const { svc, tx, audit } = build(withSecret);
    await svc.transfer("u1", "srv1", "teamB");
    expect(tx.server.updateMany).toHaveBeenCalledWith({
      where: { id: "srv1", teamId: "teamA" },
      data: expect.objectContaining({ teamId: "teamB", dnsCredsEnc: null, dnsProvider: null, certMode: "http" }),
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ detached: ["dns_secret"] }) }));
  });

  it("does not touch the DNS columns when no token was copied, and lists the wipe in the preview", async () => {
    const plain = build(both);
    await plain.svc.transfer("u1", "srv1", "teamB");
    expect((plain.tx.server.updateMany.mock.calls[0][0] as { data: object }).data).not.toHaveProperty("dnsCredsEnc");
    const preview = await build(withSecret).svc.preview("u1", "srv1", "teamB");
    expect(preview.detaches).toEqual([{ kind: "dns_secret" }]);
    expect(preview.canMove).toBe(true);
  });
});

describe("ServerTeamTransferService.preview", () => {
  it("lists what would be dropped and is movable when nothing blocks", async () => {
    const { svc, tx } = build({ ...both, server: { ...SERVER, cloudCredentialId: "cc1" }, channelLinks: 1 });
    const plan = await svc.preview("u1", "srv1", "teamB");
    expect(plan).toEqual({
      server: { id: "srv1", name: "app-1" },
      from: { id: "teamA", name: "Acme" },
      to: { id: "teamB", name: "Beta" },
      blockers: [],
      detaches: [{ kind: "cloud_credential", name: "Provider key" }, { kind: "alert_channels", count: 1 }],
      canMove: true,
    });
    expect(tx.server.updateMany).not.toHaveBeenCalled();
  });

  it("is not movable when blocked, and still authorizes first", async () => {
    const ok = build({ ...both, blockers: { database: [{ id: "d1", name: "pg" }] } });
    expect((await ok.svc.preview("u1", "srv1", "teamB")).canMove).toBe(false);
    const denied = build({ memberships: { teamA: viewer, teamB: admin }, blockers: { database: [{ id: "d1", name: "pg" }] } });
    await expect(denied.svc.preview("u1", "srv1", "teamB")).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("ServerTeamTransferService.listTargets", () => {
  const teams = { teamA: "Acme", teamB: "Beta", teamC: "Gamma", teamD: "Delta" };

  it("offers only other teams where the caller manages servers", async () => {
    const { svc } = build({ teams, memberships: { teamA: admin, teamB: admin, teamC: viewer } });
    expect(await svc.listTargets("u1", "srv1")).toEqual([{ id: "teamB", name: "Beta" }]);
  });

  it("offers every other team to the instance owner", async () => {
    const { svc } = build({ teams, user: { isInstanceOwner: true } });
    expect((await svc.listTargets("owner", "srv1")).map((t) => t.id).sort()).toEqual(["teamB", "teamC", "teamD"]);
  });

  it("refuses a caller without servers:manage on the server's team", async () => {
    const { svc } = build({ teams, memberships: { teamA: viewer, teamB: admin } });
    await expect(svc.listTargets("u1", "srv1")).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("ServerTeamTransferService.transferBulk", () => {
  it("returns a result per server: moved, blocked and denied", async () => {
    const { svc, prisma, tx } = build({ ...both });
    prisma.server.findUnique
      .mockResolvedValueOnce({ ...SERVER, id: "s1" })
      .mockResolvedValueOnce({ ...SERVER, id: "s2" })
      .mockResolvedValueOnce(null);
    // s2 is blocked by a database; s1 passes (database scan: preview s1, tx s1, preview s2).
    tx.database.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    tx.database.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "d1", name: "pg" }]);
    const res = await svc.transferBulk("u1", ["s1", "s2", "ghost"], "teamB");
    expect(res.moved).toBe(1);
    expect(res.results.map((r) => [r.serverId, r.status])).toEqual([["s1", "moved"], ["s2", "blocked"], ["ghost", "denied"]]);
    expect(res.results[1].blockers?.[0]).toMatchObject({ kind: "database", count: 1 });
  });

  it("reports a server already in the destination as unchanged", async () => {
    const { svc, prisma } = build({ ...both });
    prisma.server.findUnique.mockResolvedValueOnce({ ...SERVER, teamId: "teamB" });
    const res = await svc.transferBulk("u1", ["s1"], "teamB");
    expect(res.results).toEqual([{ serverId: "s1", status: "unchanged", message: "the server is already in this team" }]);
  });

  it("a server the caller cannot manage looks exactly like a missing one", async () => {
    const { svc, prisma } = build({ memberships: { teamA: viewer, teamB: admin } });
    prisma.server.findUnique.mockResolvedValue({ ...SERVER, id: "s1" });
    const res = await svc.transferBulk("u1", ["s1"], "teamB");
    expect(res.results).toEqual([{ serverId: "s1", status: "denied" }]);
  });

  it("fails fast on the destination, dedupes ids, and caps the batch", async () => {
    const noRights = build({ memberships: { teamA: admin } });
    await expect(noRights.svc.transferBulk("u1", ["s1"], "teamB")).rejects.toBeInstanceOf(ForbiddenException);
    expect(noRights.prisma.server.findUnique).not.toHaveBeenCalled();

    const dup = build(both);
    const res = await dup.svc.transferBulk("u1", ["s1", "s1", "s1"], "teamB");
    expect(res.results).toHaveLength(1);

    await expect(build(both).svc.transferBulk("u1", [], "teamB")).rejects.toBeInstanceOf(BadRequestException);
    await expect(build(both).svc.transferBulk("u1", Array.from({ length: 51 }, (_, i) => `s${i}`), "teamB")).rejects.toBeInstanceOf(BadRequestException);
  });
});

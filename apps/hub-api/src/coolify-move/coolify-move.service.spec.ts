import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { CoolifySshRunView } from "@tugra/shared";
import { CoolifyMoveService, slimSshRun } from "./coolify-move.service";

const CANARY = "CANARY-do-not-leak-9f3a";
const NOW = new Date("2026-11-26T12:00:00Z");
const later = new Date("2026-11-27T12:00:00Z");
const earlier = new Date("2026-11-20T12:00:00Z");

interface Fx {
  servers?: Array<{ id: string; name: string; status: string }>;
  inventories?: Array<{ serverId: string; readAt: Date | null; counts: unknown; serverLinks: unknown }>;
  takeovers?: Array<{ serverId: string; status: string }>;
  cleanups?: Array<{ serverId: string; status: string }>;
  campaigns?: Array<{ id: string; label: string; status: string; plan: unknown; createdAt: Date }>;
  moves?: Array<{ phase: string }>;
  secretsGrant?: { revokedAt: Date | null; expiresAt: Date } | null;
  sshGrant?: { runId: string } | null;
  sshTargets?: Array<{ state: string }>;
  role?: string | null;
}

function make(fx: Fx = {}) {
  const prisma = {
    server: { findMany: jest.fn().mockResolvedValue(fx.servers ?? []), findUnique: jest.fn() },
    coolifyInventory: { findMany: jest.fn().mockResolvedValue(fx.inventories ?? []) },
    coolifyTakeover: { findMany: jest.fn().mockResolvedValue(fx.takeovers ?? []) },
    coolifyCleanup: { findMany: jest.fn().mockResolvedValue(fx.cleanups ?? []) },
    migrationCampaign: { findMany: jest.fn().mockResolvedValue(fx.campaigns ?? []) },
    projectMove: { findMany: jest.fn().mockResolvedValue(fx.moves ?? []) },
    coolifyHostGrant: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: { kind: string } }) => Promise.resolve(where.kind === "secrets" ? (fx.secretsGrant ?? null) : (fx.sshGrant ?? null))),
    },
    coolifySshTarget: { findMany: jest.fn().mockResolvedValue(fx.sshTargets ?? []) },
  };
  const access = {
    requireRole: jest.fn().mockImplementation(async () => {
      if (fx.role === null) throw new ForbiddenException("insufficient role for this team");
    }),
  };
  const takeover = { list: jest.fn().mockResolvedValue([]) };
  const grants = { list: jest.fn().mockResolvedValue([]) };
  const ssh = { latestRun: jest.fn().mockResolvedValue(null), getRun: jest.fn() };
  const inplace = { list: jest.fn().mockResolvedValue([]) };
  const campaigns = { list: jest.fn().mockResolvedValue([]), get: jest.fn() };
  const cleanup = { latest: jest.fn().mockResolvedValue(null) };
  const moves = { list: jest.fn().mockResolvedValue([]), get: jest.fn() };
  const svc = new CoolifyMoveService(prisma as never, access as never, takeover as never, grants as never, ssh as never, inplace as never, campaigns as never, cleanup as never, moves as never);
  return { svc, prisma, access, takeover, grants, ssh, inplace, campaigns, cleanup, moves };
}

describe("CoolifyMoveService.status", () => {
  it("is for a team owner or admin only, and reads nothing before the check passes", async () => {
    const m = make({ role: null });
    await expect(m.svc.status("u1", "t1", NOW)).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.prisma.server.findMany).not.toHaveBeenCalled();
    expect(m.access.requireRole.mock.calls[0].slice(0, 2)).toEqual(["u1", "t1"]);
    expect(m.access.requireRole.mock.calls[0][2]).toEqual(["OWNER", "ADMIN"]);
  });

  it("puts every server on the stage it needs next", async () => {
    const m = make({
      servers: [
        { id: "hub", name: "coolify-hub", status: "ONLINE" },
        { id: "a", name: "a", status: "ONLINE" },
        { id: "b", name: "b", status: "ONLINE" },
        { id: "c", name: "c", status: "OFFLINE" },
        { id: "d", name: "d", status: "ONLINE" },
        { id: "e", name: "e", status: "ONLINE" },
      ],
      inventories: [{ serverId: "hub", readAt: earlier, counts: { servers: 5 }, serverLinks: { u1: { teamId: "t1", serverId: "a" }, u2: { teamId: "t1", serverId: "b" }, u3: { teamId: "t1", serverId: "c" }, u4: { teamId: "OTHER", serverId: "e" } } }],
      takeovers: [{ serverId: "a", status: "VERIFIED" }, { serverId: "b", status: "PLANNED" }],
      cleanups: [{ serverId: "a", status: "CLEANED" }],
    });
    const v = await m.svc.status("u1", "t1", NOW);
    const stage = Object.fromEntries(v.servers.map((s) => [s.serverId, s.stage]));
    // a is cleaned; b still has to be taken over; c has no agent; d and e are not known to Coolify (a link of another team does not count).
    expect(stage).toEqual({ hub: "hub", a: "done", b: "takeover", c: "agent", d: "not_coolify", e: "not_coolify" });
    expect(v.steps.map((s) => [s.step, s.done, s.total])).toEqual([["takeover", 1, 3], ["cleanup", 1, 3], ["consolidate", 0, 0], ["shutdown", 0, 1]]);
    expect(v.hub).toMatchObject({ serverId: "hub", name: "coolify-hub", knownServers: 5, secrets: "none", secretsExpiresAt: null, ssh: null });
  });

  it("scopes every query to the team and takes only the newest takeover and cleanup per server", async () => {
    const m = make();
    await m.svc.status("u1", "t1", NOW);
    for (const t of ["server", "coolifyInventory", "coolifyTakeover", "coolifyCleanup", "migrationCampaign", "projectMove"] as const) {
      expect(m.prisma[t].findMany.mock.calls[0][0].where).toEqual({ teamId: "t1" });
    }
    expect(m.prisma.coolifyTakeover.findMany.mock.calls[0][0]).toMatchObject({ orderBy: { createdAt: "desc" }, distinct: ["serverId"] });
    expect(m.prisma.coolifyCleanup.findMany.mock.calls[0][0]).toMatchObject({ orderBy: { createdAt: "desc" }, distinct: ["serverId"] });
  });

  it("reports the consent state: active with its end, expired, revoked, none", async () => {
    const inv = [{ serverId: "hub", readAt: earlier, counts: null, serverLinks: {} }];
    const servers = [{ id: "hub", name: "h", status: "ONLINE" }];
    const active = await make({ servers, inventories: inv, secretsGrant: { revokedAt: null, expiresAt: later } }).svc.status("u1", "t1", NOW);
    expect(active.hub).toMatchObject({ secrets: "active", secretsExpiresAt: later.toISOString() });
    const expired = await make({ servers, inventories: inv, secretsGrant: { revokedAt: null, expiresAt: earlier } }).svc.status("u1", "t1", NOW);
    expect(expired.hub).toMatchObject({ secrets: "expired", secretsExpiresAt: null });
    const revoked = await make({ servers, inventories: inv, secretsGrant: { revokedAt: earlier, expiresAt: later } }).svc.status("u1", "t1", NOW);
    expect(revoked.hub).toMatchObject({ secrets: "revoked", secretsExpiresAt: null });
    const none = await make({ servers, inventories: inv }).svc.status("u1", "t1", NOW);
    expect(none.hub?.secrets).toBe("none");
  });

  it("summarises the newest SSH install as counts and says when it is not finished", async () => {
    const m = make({
      servers: [{ id: "hub", name: "h", status: "ONLINE" }],
      inventories: [{ serverId: "hub", readAt: earlier, counts: null, serverLinks: {} }],
      sshGrant: { runId: "run1" },
      sshTargets: [{ state: "ONLINE" }, { state: "FAILED" }, { state: "SKIPPED_PRESENT" }, { state: "INSTALLING" }],
    });
    const v = await m.svc.status("u1", "t1", NOW);
    expect(v.hub?.ssh).toEqual({ runId: "run1", finished: false, online: 1, failed: 1, skipped: 1, pending: 1, total: 4 });
    expect(m.prisma.coolifySshTarget.findMany.mock.calls[0][0].where).toEqual({ teamId: "t1", serverId: "hub", runId: "run1" });
    const done = await make({ servers: [{ id: "hub", name: "h", status: "ONLINE" }], inventories: [{ serverId: "hub", readAt: earlier, counts: null, serverLinks: {} }], sshGrant: { runId: "r" }, sshTargets: [{ state: "ONLINE" }, { state: "REMOVED" }] }).svc.status("u1", "t1", NOW);
    expect(done.hub?.ssh?.finished).toBe(true);
  });

  it("rolls up campaigns and project moves", async () => {
    const m = make({
      campaigns: [{ id: "c1", label: "wave-1", status: "running", plan: [{}, {}, {}], createdAt: earlier }, { id: "c2", label: "x", status: "draft", plan: "junk", createdAt: earlier }],
      moves: [{ phase: "MOVING" }, { phase: "COMPLETED" }, { phase: "FAILED" }, { phase: "ROLLED_BACK" }, { phase: "COMPLETED" }],
    });
    const v = await m.svc.status("u1", "t1", NOW);
    expect(v.campaigns.map((c) => [c.label, c.runs])).toEqual([["wave-1", 3], ["x", 0]]);
    expect(v.projectMoves).toEqual({ total: 5, active: 1, completed: 2, failed: 2, latestPhase: "MOVING" });
  });

  it("selects no secret column and its output carries no field it was not built from", async () => {
    const m = make({
      servers: [{ id: "hub", name: "h", status: "ONLINE", enrollToken: CANARY, dnsCredsEnc: CANARY } as never],
      inventories: [{ serverId: "hub", readAt: earlier, counts: { servers: 1 }, serverLinks: {}, snapshot: CANARY } as never],
      takeovers: [{ serverId: "hub", status: "VERIFIED", plan: CANARY, rollback: CANARY } as never],
      cleanups: [{ serverId: "hub", status: "READY", remnants: CANARY } as never],
      secretsGrant: { revokedAt: null, expiresAt: later, recipientKeyEnc: CANARY, recipientPublicKey: CANARY } as never,
      sshGrant: { runId: "r1" },
      sshTargets: [{ state: "ONLINE", probe: CANARY, hostKeyFp: CANARY } as never],
    });
    const v = await m.svc.status("u1", "t1", NOW);
    expect(JSON.stringify(v)).not.toContain(CANARY);
    const selected = (fn: jest.Mock) => Object.keys(fn.mock.calls[0][0].select);
    expect(selected(m.prisma.server.findMany)).toEqual(["id", "name", "status"]);
    expect(selected(m.prisma.coolifyInventory.findMany)).toEqual(["serverId", "readAt", "counts", "serverLinks"]);
    expect(selected(m.prisma.coolifyTakeover.findMany)).toEqual(["serverId", "status"]);
    expect(selected(m.prisma.coolifyCleanup.findMany)).toEqual(["serverId", "status"]);
    expect(selected(m.prisma.coolifySshTarget.findMany)).toEqual(["state"]);
    for (const c of m.prisma.coolifyHostGrant.findFirst.mock.calls) {
      const sel = Object.keys(c[0].select);
      expect(sel).not.toContain("recipientKeyEnc");
      expect(sel).not.toContain("recipientPublicKey");
    }
  });
});

describe("slimSshRun", () => {
  it("drops the probe facts (hashed host ids, fingerprints) and keeps names, states and fixed codes", () => {
    const run = {
      runId: "r1",
      inventoryServerId: "hub",
      teamId: "t1",
      expiresAt: "2026-11-27T00:00:00Z",
      finished: false,
      targets: [
        {
          id: "x",
          runId: "r1",
          coolifyServerUuid: "abc123",
          name: "web-1",
          state: "FAILED",
          code: "needs_root",
          tugraServerId: null,
          manualCommand: true,
          canRemove: false,
          probe: { machineIdHash: CANARY, dockerEngineId: CANARY, sshHostKeyFp: CANARY },
          updatedAt: "2026-11-26T00:00:00Z",
        },
      ],
    } as unknown as CoolifySshRunView;
    const slim = slimSshRun(run);
    expect(JSON.stringify(slim)).not.toContain(CANARY);
    expect(slim).toEqual({ runId: "r1", finished: false, expiresAt: "2026-11-27T00:00:00Z", targets: [{ name: "web-1", state: "FAILED", code: "needs_root", tugraServerId: null, manualCommand: true, canRemove: false }] });
  });
});

describe("CoolifyMoveService status reads", () => {
  it("takeoverStatus keeps only this server's inventory summary and secrets consent, through the role-checked services", async () => {
    const m = make();
    m.prisma.server.findUnique.mockResolvedValue({ teamId: "t1" });
    m.takeover.list.mockResolvedValue([{ serverId: "other", counts: {} }, { serverId: "s1", counts: { servers: 2 } }]);
    m.grants.list.mockResolvedValue([
      { id: "g1", serverId: "s1", kind: "secrets" },
      { id: "g2", serverId: "s1", kind: "ssh" },
      { id: "g3", serverId: "other", kind: "secrets" },
    ]);
    m.inplace.list.mockResolvedValue([{ id: "tk1" }]);
    const r = await m.svc.takeoverStatus("u1", "s1");
    expect(r).toEqual({ serverId: "s1", inventory: { serverId: "s1", counts: { servers: 2 } }, secretsGrants: [{ id: "g1", serverId: "s1", kind: "secrets" }], takeovers: [{ id: "tk1" }] });
    expect(m.takeover.list).toHaveBeenCalledWith("u1", "t1");
    expect(m.grants.list).toHaveBeenCalledWith("u1", "t1");
    expect(m.inplace.list).toHaveBeenCalledWith("u1", "s1");
  });

  it("an unknown server is not found, and nothing else is read", async () => {
    const m = make();
    m.prisma.server.findUnique.mockResolvedValue(null);
    await expect(m.svc.takeoverStatus("u1", "nope")).rejects.toBeInstanceOf(NotFoundException);
    expect(m.takeover.list).not.toHaveBeenCalled();
    expect(m.grants.list).not.toHaveBeenCalled();
  });

  it("a role failure inside a delegated service propagates", async () => {
    const m = make();
    m.prisma.server.findUnique.mockResolvedValue({ teamId: "t1" });
    m.takeover.list.mockRejectedValue(new ForbiddenException("insufficient role for this team"));
    await expect(m.svc.takeoverStatus("u1", "s1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("campaignStatus lists a team's campaigns or gets one", async () => {
    const m = make();
    m.campaigns.list.mockResolvedValue([{ id: "c1" }]);
    m.campaigns.get.mockResolvedValue({ id: "c1" });
    expect(await m.svc.campaignStatus("u1", "t1")).toEqual({ campaigns: [{ id: "c1" }] });
    expect(await m.svc.campaignStatus("u1", "t1", "c1")).toEqual({ campaign: { id: "c1" } });
    expect(m.campaigns.get).toHaveBeenCalledWith("u1", "c1");
  });

  it("cleanupStatus returns the newest checklist or null", async () => {
    const m = make();
    expect(await m.svc.cleanupStatus("u1", "s1")).toEqual({ serverId: "s1", cleanup: null });
    m.cleanup.latest.mockResolvedValue({ id: "cl1", status: "READY" });
    expect(await m.svc.cleanupStatus("u1", "s1")).toEqual({ serverId: "s1", cleanup: { id: "cl1", status: "READY" } });
  });

  it("sshInstallStatus uses the newest run, or the named one, and returns the slim shape", async () => {
    const m = make();
    expect(await m.svc.sshInstallStatus("u1", "s1")).toEqual({ serverId: "s1", run: null });
    const view = { runId: "r1", finished: true, expiresAt: "x", targets: [{ name: "n", state: "ONLINE", code: null, tugraServerId: "t", manualCommand: false, canRemove: true, probe: { machineIdHash: CANARY } }] };
    m.ssh.getRun.mockResolvedValue(view);
    const r = await m.svc.sshInstallStatus("u1", "s1", "r1");
    expect(m.ssh.getRun).toHaveBeenCalledWith("u1", "s1", "r1");
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it("projectMoveStatus lists a project's moves, and a move of another project is not found", async () => {
    const m = make();
    m.moves.list.mockResolvedValue([{ id: "m1" }]);
    expect(await m.svc.projectMoveStatus("u1", "p1")).toEqual({ moves: [{ id: "m1" }] });
    m.moves.get.mockResolvedValue({ id: "m2", projectId: "p1" });
    expect(await m.svc.projectMoveStatus("u1", "p1", "m2")).toEqual({ move: { id: "m2", projectId: "p1" } });
    m.moves.get.mockResolvedValue({ id: "m3", projectId: "p2" });
    await expect(m.svc.projectMoveStatus("u1", "p1", "m3")).rejects.toBeInstanceOf(NotFoundException);
  });
});

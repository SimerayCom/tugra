import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ProjectMovesService } from "./project-moves.service";
import type { StoredPlan } from "./project-move-state";

type Row = Record<string, unknown>;

interface Opts {
  role?: string | null;
  online?: { s1?: boolean; s2?: boolean };
  targetTeam?: string;
  apps?: Row[];
  dbs?: Row[];
  links?: Array<{ appId: string; databaseId: string }>;
  preflight?: (appId: string) => string[];
  active?: boolean;
  move?: Row | null;
  dbRows?: Record<string, Row>;
  linkCounts?: Record<string, number>;
  due?: Row[];
}

function make(o: Opts = {}) {
  const created: Row[] = [];
  const audits: Array<{ action: string; meta?: Row }> = [];
  const projectRow = { id: "p1", name: "proj", teamId: "t1" };
  const apps = o.apps ?? [
    { id: "a1", name: "web", serverId: "s1", status: "RUNNING" },
    { id: "a2", name: "worker", serverId: "s1", status: "RUNNING" },
  ];
  const dbs = o.dbs ?? [{ id: "d1", name: "main", engine: "POSTGRES", serverId: "s1", status: "RUNNING", backupDestinationId: "dest", volumes: null, pitrEnabled: false }];
  const servers: Record<string, Row> = {
    s1: { id: "s1", teamId: "t1", status: "ONLINE", publicIp: "1.1.1.1" },
    s2: { id: "s2", teamId: o.targetTeam ?? "t1", status: "ONLINE", publicIp: "2.2.2.2" },
  };
  const move: Row | null =
    o.move === undefined ? null : o.move && { id: "pm1", teamId: "t1", projectId: "p1", sourceServerId: "s1", targetServerId: "s2", phase: "COMPLETED", plan: {}, items: [], retainDays: 7, archiveUntil: new Date(), failureReason: null, createdAt: new Date(), finishedAt: null, actorId: "u1", ...o.move };
  const dbRows: Record<string, Row> = o.dbRows ?? {};
  const prisma = {
    project: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === "p1" ? projectRow : null)) },
    environment: { findMany: jest.fn(async () => [{ id: "e1" }]) },
    application: { findMany: jest.fn(async () => apps) },
    database: {
      findMany: jest.fn(async () => dbs),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => dbRows[where.id] ?? null),
    },
    appDatabaseLink: {
      findMany: jest.fn(async () => o.links ?? []),
      count: jest.fn(async ({ where }: { where: { databaseId: string } }) => o.linkCounts?.[where.databaseId] ?? 0),
    },
    server: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => servers[where.id] ?? null) },
    appMove: { findMany: jest.fn(async () => []) },
    projectMove: {
      findFirst: jest.fn(async () => (o.active ? { id: "other" } : null)),
      findUnique: jest.fn(async () => (move ? { ...move } : null)),
      findMany: jest.fn(async ({ where }: { where: { phase?: unknown } }) => (where.phase === "COMPLETED" ? (o.due ?? []) : move ? [{ ...move }] : [])),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: "pmNEW", createdAt: new Date(), phase: "QUEUED", archiveUntil: null, failureReason: null, finishedAt: null, ...data };
        created.push(row);
        return row;
      }),
      update: jest.fn(async ({ data }: { data: Row }) => void Object.assign(move ?? {}, data)),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    $queryRaw: jest.fn(async () => []),
    $transaction: undefined as unknown as jest.Mock,
  };
  prisma.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(prisma));
  const access = {
    teamRole: jest.fn(async () => (o.role === undefined ? "OWNER" : o.role)),
    requireProjectAccess: jest.fn(async () => undefined),
  };
  const audit = { log: jest.fn(async (a: { action: string; meta?: Row }) => void audits.push(a)) };
  const agentWs = { isOnline: jest.fn((id: string) => (id === "s1" ? o.online?.s1 : o.online?.s2) !== false) };
  const appMoves = {
    preflight: jest.fn(async (_u: string, appId: string) => ({ blockers: (o.preflight?.(appId) ?? []).map((code) => ({ code, message: "" })) })),
    purgeSource: jest.fn(async () => undefined),
  };
  const databases = { remove: jest.fn(async () => undefined) };
  const runner = { run: jest.fn(async () => undefined) };
  const svc = new ProjectMovesService(prisma as never, access as never, audit as never, agentWs as never, appMoves as never, databases as never, runner as never);
  return { svc, prisma, access, audit, audits, agentWs, appMoves, databases, runner, created, move };
}

const PREVIEW = { projectId: "p1", targetServerId: "s2", acknowledge: {} } as never;
const START = { ...(PREVIEW as object), repointDns: false, retainDays: 7, confirmName: "proj" } as never;

describe("ProjectMovesService.preview", () => {
  it("only a team owner may preview: an admin, a member or a stranger is refused before anything is read", async () => {
    for (const role of ["ADMIN", "VIEWER", null]) {
      const t = make({ role });
      await expect(t.svc.preview("u1", PREVIEW)).rejects.toBeInstanceOf(ForbiddenException);
      expect(t.appMoves.preflight).not.toHaveBeenCalled();
    }
  });

  it("an unknown project is 404; a target server of another team is 404 (no oracle)", async () => {
    await expect(make().svc.preview("u1", { ...(PREVIEW as object), projectId: "nope" } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ targetTeam: "t9" }).svc.preview("u1", PREVIEW)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a clean project previews with no blocker: databases first, each app's own preflight asked with the owner's acknowledgements and no link probe", async () => {
    const t = make();
    const p = await t.svc.preview("u1", { ...(PREVIEW as object), acknowledge: { hostMounts: true } } as never);
    expect(p.blockers).toEqual([]);
    expect(p.sourceServerId).toBe("s1");
    expect(p.items.map((i) => i.name)).toEqual(["main", "web", "worker"]);
    expect(t.appMoves.preflight).toHaveBeenCalledTimes(2);
    expect(t.appMoves.preflight).toHaveBeenCalledWith("u1", "a1", { targetServerId: "s2", acknowledge: { hostMounts: true }, probeLink: false });
  });

  it("offline agents, a database without an S3 destination and an app preflight blocker are all reported at once", async () => {
    const t = make({
      online: { s2: false },
      dbs: [{ id: "d1", name: "main", engine: "POSTGRES", serverId: "s1", status: "RUNNING", backupDestinationId: null, volumes: null, pitrEnabled: false }],
      preflight: (id) => (id === "a1" ? ["db_links_exist", "target_volume_exists"] : []),
    });
    const p = await t.svc.preview("u1", PREVIEW);
    expect(p.blockers.map((b) => b.code).sort()).toEqual(["agent_offline_target", "app_preflight_failed", "db_needs_s3_destination"]);
    expect(p.blockers.find((b) => b.code === "app_preflight_failed")).toMatchObject({ ref: "web", codes: ["target_volume_exists"] });
  });

  it("items on several servers need the source named", async () => {
    const apps = [{ id: "a1", name: "web", serverId: "s1", status: "RUNNING" }, { id: "a2", name: "worker", serverId: "s3", status: "RUNNING" }];
    expect((await make({ apps, dbs: [] }).svc.preview("u1", PREVIEW)).blockers.map((b) => b.code)).toContain("items_on_several_servers");
    const named = await make({ apps, dbs: [] }).svc.preview("u1", { ...(PREVIEW as object), sourceServerId: "s1" } as never);
    expect(named.items.map((i) => i.name)).toEqual(["web"]);
    expect(named.warnings).toContainEqual({ code: "items_left_behind" });
  });

  it("an app outside the project linked to a project database blocks it", async () => {
    const t = make({ links: [{ appId: "outside", databaseId: "d1" }] });
    expect((await t.svc.preview("u1", PREVIEW)).blockers).toEqual([{ code: "db_linked_outside", ref: "main" }]);
  });

  it("a move already running on the project is reported", async () => {
    expect((await make({ active: true }).svc.preview("u1", PREVIEW)).blockers.map((b) => b.code)).toContain("project_move_active");
  });
});

describe("ProjectMovesService.start", () => {
  it("needs the owner and the project's exact name", async () => {
    await expect(make({ role: "ADMIN" }).svc.start("u1", START)).rejects.toBeInstanceOf(ForbiddenException);
    const t = make();
    await expect(t.svc.start("u1", { ...(START as object), confirmName: "wrong" } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(t.created).toEqual([]);
    expect(t.runner.run).not.toHaveBeenCalled();
  });

  it("any blocker refuses the start with the list, and nothing is created or run", async () => {
    const t = make({ online: { s1: false } });
    await expect(t.svc.start("u1", START)).rejects.toMatchObject({ response: expect.objectContaining({ code: "preflight_failed", blockers: [expect.objectContaining({ code: "agent_offline_source" })] }) });
    expect(t.created).toEqual([]);
    expect(t.runner.run).not.toHaveBeenCalled();
  });

  it("creates the move with its items and stored stages, audits it and hands it to the runner", async () => {
    const t = make({ links: [{ appId: "a1", databaseId: "d1" }] });
    const out = await t.svc.start("u1", { ...(START as object), repointDns: true, retainDays: 14, acknowledge: { hostMounts: true } } as never);
    expect(out).toEqual({ moveId: "pmNEW", phase: "QUEUED" });
    const row = t.created[0] as { plan: StoredPlan; items: Array<{ kind: string; name: string; phase: string }>; retainDays: number; repointDns: boolean; sourceServerId: string; targetServerId: string; actorId: string };
    expect(row).toMatchObject({ sourceServerId: "s1", targetServerId: "s2", actorId: "u1", retainDays: 14, repointDns: true });
    expect(row.items.map((i) => `${i.kind}:${i.name}:${i.phase}`)).toEqual(["database:main:pending", "application:web:pending", "application:worker:pending"]);
    expect(row.plan.dbs.d1).toEqual({ stage: "pending", configOnly: false, oldName: "main" });
    expect(row.plan.apps.a1.stage).toBe("pending");
    expect(row.plan).toMatchObject({ acks: { hostMounts: true }, repointDns: true, targetIp: "2.2.2.2", frozen: [] });
    expect(row.plan.warnings).toContain("app_redeploy_after_relink:web");
    expect(t.audits.find((a) => a.action === "project.move.start")?.meta).toMatchObject({ moveId: "pmNEW", from: "s1", to: "s2", applications: 2, databases: 1, retainDays: 14 });
    expect(t.runner.run).toHaveBeenCalledWith("pmNEW");
    expect(t.prisma.$queryRaw).toHaveBeenCalled(); // the project row is locked for the check-and-insert
  });

  it("two starts at once: the one that finds a live move gets 409 project_move_active", async () => {
    const t = make();
    t.prisma.projectMove.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "racing" });
    await expect(t.svc.start("u1", START)).rejects.toMatchObject({ response: expect.objectContaining({ code: "project_move_active" }) });
    expect(t.created).toEqual([]);
    expect(t.runner.run).not.toHaveBeenCalled();
  });
});

describe("ProjectMovesService.cancel", () => {
  it("owner only, and only while nothing has been cut over", async () => {
    await expect(make({ role: "ADMIN", move: { phase: "MOVING" } }).svc.cancel("u1", "pm1")).rejects.toBeInstanceOf(ForbiddenException);
    const t = make({ move: { phase: "MOVING" } });
    await t.svc.cancel("u1", "pm1");
    expect(t.prisma.projectMove.updateMany).toHaveBeenCalledWith({ where: { id: "pm1", phase: { in: ["QUEUED", "PRECHECK", "MOVING"] } }, data: { cancelRequested: true } });
    expect(t.audits.map((a) => a.action)).toContain("project.move.cancel");
    for (const phase of ["VERIFYING", "CUTOVER", "COMPLETED", "FAILED", "ROLLING_BACK"]) {
      await expect(make({ move: { phase } }).svc.cancel("u1", "pm1")).rejects.toMatchObject({ response: expect.objectContaining({ code: "move_not_cancellable" }) });
    }
  });

  it("losing the race with the phase change is a 409", async () => {
    const t = make({ move: { phase: "MOVING" } });
    t.prisma.projectMove.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(t.svc.cancel("u1", "pm1")).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("ProjectMovesService.purgeSafetyCopy", () => {
  const plan = (over: Partial<StoredPlan> = {}): StoredPlan => ({
    v: 1, acks: {} as never, repointDns: false, confirmName: "proj", frozen: [], targetIp: null, warnings: [],
    dbs: { d1: { stage: "source_stopped", configOnly: false, oldName: "main", targetDbId: "d1copy", setAside: true }, d2: { stage: "source_stopped", configOnly: false, oldName: "cache", targetDbId: "d2copy", setAside: true } },
    apps: { a1: { stage: "redeployed", moveId: "mv1", links: [], hadDbNetwork: false, wasRunning: true } },
    ...over,
  });

  it("owner only, and only a completed move", async () => {
    await expect(make({ role: "ADMIN", move: { plan: plan() } }).svc.purgeSafetyCopy("u1", "pm1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make({ move: { phase: "MOVING", plan: plan() } }).svc.purgeSafetyCopy("u1", "pm1")).rejects.toMatchObject({ response: expect.objectContaining({ code: "move_not_completed" }) });
    await expect(make({ move: { plan: plan({ safetyPurged: true }) } }).svc.purgeSafetyCopy("u1", "pm1")).rejects.toMatchObject({ response: expect.objectContaining({ code: "nothing_to_purge" }) });
  });

  it("removes a stopped, unused old database; keeps one that is running or still linked; asks the app move to drop its archive", async () => {
    const t = make({ move: { plan: plan() }, dbRows: { d1: { id: "d1", status: "STOPPED" }, d2: { id: "d2", status: "STOPPED" } }, linkCounts: { d2: 1 } });
    expect(await t.svc.purgeSafetyCopy("u1", "pm1")).toEqual({ removed: 1, kept: 1 });
    expect(t.databases.remove).toHaveBeenCalledTimes(1);
    expect(t.databases.remove).toHaveBeenCalledWith("u1", "d1", { keepVolume: false });
    expect(t.appMoves.purgeSource).toHaveBeenCalledWith("u1", "a1", "mv1");
    expect(t.audits.find((a) => a.action === "project.move.purge")?.meta).toMatchObject({ removed: 1, kept: 1 });
    const stored = t.prisma.projectMove.update.mock.calls[0][0].data.plan as StoredPlan;
    expect(stored.safetyPurged).toBe(true);
  });

  it("never removes a database that is not stopped, whatever the plan says", async () => {
    const t = make({ move: { plan: plan() }, dbRows: { d1: { id: "d1", status: "RUNNING" }, d2: { id: "d2", status: "FAILED" } } });
    expect(await t.svc.purgeSafetyCopy("u1", "pm1")).toEqual({ removed: 0, kept: 2 });
    expect(t.databases.remove).not.toHaveBeenCalled();
  });

  it("a database that was not set aside (a config-only one) is never touched", async () => {
    const t = make({ move: { plan: plan({ dbs: { d1: { stage: "source_stopped", configOnly: true, oldName: "main", targetDbId: "d1" } } }) }, dbRows: { d1: { id: "d1", status: "STOPPED" } } });
    expect(await t.svc.purgeSafetyCopy("u1", "pm1")).toEqual({ removed: 0, kept: 0 });
    expect(t.databases.remove).not.toHaveBeenCalled();
  });
});

describe("ProjectMovesService.purgeDue", () => {
  it("removes the safety copy of moves past their retention, once, and only when the actor is still an owner", async () => {
    const due = [
      { id: "pm1", teamId: "t1", actorId: "u1", projectId: "p1", plan: { v: 1, dbs: { d1: { stage: "source_stopped", configOnly: false, oldName: "main", targetDbId: "c", setAside: true } }, apps: {} } },
      { id: "pm2", teamId: "t1", actorId: "u1", projectId: "p1", plan: { v: 1, safetyPurged: true, dbs: {}, apps: {} } },
    ];
    const t = make({ due, move: { plan: {} }, dbRows: { d1: { id: "d1", status: "STOPPED" } } });
    expect(await t.svc.purgeDue()).toEqual(["pm1"]);
    expect(t.databases.remove).toHaveBeenCalledWith("u1", "d1", { keepVolume: false });

    const gone = make({ due, role: "ADMIN", dbRows: { d1: { id: "d1", status: "STOPPED" } } });
    expect(await gone.svc.purgeDue()).toEqual([]);
    expect(gone.databases.remove).not.toHaveBeenCalled();
  });
});

describe("reads", () => {
  it("a member with access to the project sees the move; a stranger does not; the view carries the report and a fixed failure code, nothing else", async () => {
    const t = make({ role: "VIEWER", move: { phase: "FAILED", failureReason: "app_move_failed", plan: { report: { checks: [], dns: [], warnings: [] }, secretish: "x" } } });
    const v = await t.svc.get("u1", "pm1");
    expect(v).toMatchObject({ phase: "FAILED", failureCode: "app_move_failed", report: { checks: [], dns: [], warnings: [] } });
    expect(JSON.stringify(v)).not.toContain("secretish");
    await expect(make({ role: null, move: {} }).svc.get("u1", "pm1")).rejects.toBeInstanceOf(ForbiddenException);
    expect((await t.svc.list("u1", "p1")).length).toBe(1);
  });
  it("an unknown move is 404", async () => {
    await expect(make({ move: null }).svc.get("u1", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });
});

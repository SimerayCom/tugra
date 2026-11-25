import { ProjectMoveRunnerService, StepError } from "./project-move-runner.service";
import { VolumeCarryError } from "./project-move-volume-carry.service";
import { parsePlan, type StoredPlan } from "./project-move-state";

const CANARY = "pw-canary-7c1e";
type Row = Record<string, unknown>;

interface World {
  move: Row;
  apps: Map<string, Row>;
  dbs: Map<string, Row>;
  links: Array<{ id: string; appId: string; databaseId: string; envVar: string }>;
  appMoves: Map<string, Row>;
  restores: Array<{ databaseId: string; status: string }>;
  calls: string[];
  audits: Array<{ action: string; meta?: Record<string, unknown> }>;
}

interface Opts {
  online?: boolean;
  failProvision?: boolean;
  failBackup?: boolean;
  failRestore?: boolean;
  failCarry?: boolean;
  /** Extra volumes of the source database d1 (name and path). */
  extraVolumes?: Array<{ name: string; path: string }>;
  /** App id -> the phase the app move ends in (default COMPLETED). */
  appMovePhase?: Record<string, string>;
  /** Make the target app not run after the move, so the verification fails. */
  appStaysStopped?: boolean;
  items?: "linked" | "plain" | "config-only";
  cancel?: boolean;
  plan?: Partial<StoredPlan>;
  ownerId?: string | null;
  moveRow?: Row;
}

function make(o: Opts = {}) {
  const w: World = { move: {}, apps: new Map(), dbs: new Map(), links: [], appMoves: new Map(), restores: [], calls: [], audits: [] };
  const kind = o.items ?? "linked";
  w.apps.set("a1", { id: "a1", name: "web", status: "RUNNING", serverId: "s1", dbNetwork: kind === "linked", domain: "web.example.com", extraDomains: [], domains: [] });
  w.apps.set("a2", { id: "a2", name: "worker", status: "RUNNING", serverId: "s1", dbNetwork: false, domain: null, extraDomains: [], domains: [] });
  w.dbs.set("d1", { id: "d1", name: "main", status: kind === "config-only" ? "NEW" : "RUNNING", serverId: "s1", volumes: o.extraVolumes ?? [] });
  if (kind === "linked") w.links.push({ id: "l1", appId: "a1", databaseId: "d1", envVar: "DATABASE_URL" });

  const items = [
    { kind: "database", refId: "d1", name: "main", childId: null, phase: "pending", tempAddress: null },
    { kind: "application", refId: "a1", name: "web", childId: null, phase: "pending", tempAddress: null },
    { kind: "application", refId: "a2", name: "worker", childId: null, phase: "pending", tempAddress: null },
  ];
  const plan: StoredPlan = {
    v: 1,
    acks: {} as never,
    repointDns: false,
    confirmName: "proj",
    dbs: { d1: { stage: "pending", configOnly: kind === "config-only", oldName: "main" } },
    apps: { a1: { stage: "pending", links: [], hadDbNetwork: false, wasRunning: false }, a2: { stage: "pending", links: [], hadDbNetwork: false, wasRunning: false } },
    frozen: [],
    targetIp: "5.6.7.8",
    warnings: [],
    ...o.plan,
  };
  w.move = { id: "pm1", teamId: "t1", actorId: "u1", projectId: "p1", sourceServerId: "s1", targetServerId: "s2", phase: "QUEUED", plan, items, retainDays: 7, repointDns: false, archiveUntil: null, failureReason: null, cancelRequested: o.cancel === true, ownerId: o.ownerId ?? null, heartbeatAt: null, startedAt: null, finishedAt: null, createdAt: new Date(), ...o.moveRow };

  let seq = 0;
  const prisma = {
    projectMove: {
      findUnique: jest.fn(async () => ({ ...w.move })),
      update: jest.fn(async ({ data }: { data: Row }) => void Object.assign(w.move, data)),
      updateMany: jest.fn(async ({ where, data }: { where: { OR?: Array<{ ownerId: unknown }> }; data: Row }) => {
        const owner = w.move.ownerId;
        const ok = !where.OR || where.OR.some((c) => c.ownerId === owner);
        if (ok) Object.assign(w.move, data);
        return { count: ok ? 1 : 0 };
      }),
    },
    application: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (w.apps.get(where.id) ? { ...w.apps.get(where.id) } : null)),
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => w.apps.get(id)).filter(Boolean).map((r) => ({ ...r }))),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => void Object.assign(w.apps.get(where.id)!, data)),
    },
    appDatabaseLink: {
      findMany: jest.fn(async ({ where }: { where: { appId?: unknown; databaseId?: { in: string[] } } }) => {
        const appIds = where.appId && typeof where.appId === "object" ? (where.appId as { in: string[] }).in : where.appId ? [where.appId as string] : null;
        return w.links.filter((l) => (!appIds || appIds.includes(l.appId)) && (!where.databaseId || where.databaseId.in.includes(l.databaseId))).map((l) => ({ ...l }));
      }),
      count: jest.fn(async ({ where }: { where: { appId?: string; databaseId?: string } }) => w.links.filter((l) => (!where.appId || l.appId === where.appId) && (!where.databaseId || l.databaseId === where.databaseId)).length),
    },
    appMove: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (w.appMoves.get(where.id) ? { ...w.appMoves.get(where.id) } : null)) },
    database: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (w.dbs.get(where.id) ? { ...w.dbs.get(where.id) } : null)),
    },
    restore: { findFirst: jest.fn(async ({ where }: { where: { databaseId: string; status: string } }) => w.restores.find((r) => r.databaseId === where.databaseId && r.status === where.status) ?? null) },
  };
  const audit = { log: jest.fn(async (a: { action: string; meta?: Row }) => void w.audits.push(a)) };
  const agentWs = { isOnline: jest.fn(() => o.online !== false) };
  const apps = {
    stop: jest.fn(async (_u: string, id: string) => { w.calls.push(`app.stop:${id}`); w.apps.get(id)!.status = "STOPPED"; }),
    start: jest.fn(async (_u: string, id: string) => { w.calls.push(`app.start:${id}`); w.apps.get(id)!.status = "RUNNING"; }),
    deploy: jest.fn(async (_u: string, id: string) => { w.calls.push(`app.deploy:${id}`); w.apps.get(id)!.status = o.appStaysStopped ? "STOPPED" : "RUNNING"; }),
  };
  const links = {
    remove: jest.fn(async (_u: string, appId: string, linkId: string) => { w.calls.push(`link.remove:${appId}:${linkId}`); w.links = w.links.filter((l) => l.id !== linkId); }),
    create: jest.fn(async (_u: string, appId: string, i: { databaseId: string; envVar: string }) => {
      w.calls.push(`link.create:${appId}:${i.databaseId}:${i.envVar}`);
      w.links.push({ id: `l${++seq + 10}`, appId, databaseId: i.databaseId, envVar: i.envVar });
      w.apps.get(appId)!.dbNetwork = true;
    }),
  };
  const appMoves = {
    cancel: jest.fn(async (_u: string, appId: string, moveId: string) => void w.calls.push(`appmove.cancel:${appId}:${moveId}`)),
    start: jest.fn(async (_u: string, appId: string, i: { targetServerId: string; confirmName: string }) => {
      w.calls.push(`appmove.start:${appId}`);
      if (i.confirmName !== w.apps.get(appId)!.name) throw new Error("confirm");
      const phase = o.appMovePhase?.[appId] ?? "COMPLETED";
      const id = `mv-${appId}`;
      w.appMoves.set(id, { id, phase, plan: { domain: { to: `${appId}.sslip.io` } } });
      if (phase === "COMPLETED") w.apps.get(appId)!.serverId = i.targetServerId;
      return { moveId: id, phase: "QUEUED" };
    }),
  };
  const databases = {
    clone: jest.fn(async (_u: string, id: string, i: { name: string }) => {
      w.calls.push(`db.clone:${id}`);
      const nid = "d1copy";
      w.dbs.set(nid, { id: nid, name: i.name, status: "NEW", serverId: w.dbs.get(id)!.serverId });
      return { id: nid };
    }),
    moveToServer: jest.fn(async (_u: string, id: string, server: string) => { w.calls.push(`db.moveToServer:${id}:${server}`); w.dbs.get(id)!.serverId = server; }),
    provision: jest.fn(async (_u: string, id: string) => { w.calls.push(`db.provision:${id}`); const s = o.failProvision ? "FAILED" : "RUNNING"; w.dbs.get(id)!.status = s; return { status: s }; }),
    stop: jest.fn(async (_u: string, id: string) => { w.calls.push(`db.stop:${id}`); w.dbs.get(id)!.status = "STOPPED"; }),
    rename: jest.fn(async (_u: string, id: string, name: string) => { w.calls.push(`db.rename:${id}`); w.dbs.get(id)!.name = name; }),
    remove: jest.fn(async (_u: string, id: string) => { w.calls.push(`db.remove:${id}`); w.dbs.delete(id); }),
  };
  const backups = {
    backupNow: jest.fn(async (_u: string, id: string) => { w.calls.push(`backup:${id}`); return { id: "b1", status: o.failBackup ? "FAILED" : "SUCCESS" }; }),
    restoreTo: jest.fn(async (_u: string, src: string, _b: string, tgt: string) => {
      w.calls.push(`restore:${src}->${tgt}`);
      if (o.failRestore) throw new Error(`pg said ${CANARY}`);
      w.restores.push({ databaseId: tgt, status: "SUCCESS" });
    }),
  };
  const carry = { carry: jest.fn(async (i: { dstVolume: string }) => { w.calls.push(`carry:${i.dstVolume}`); if (o.failCarry) throw new VolumeCarryError("pack_failed"); }) };
  const lease = { bootId: "boot1" };
  const svc = new ProjectMoveRunnerService(prisma as never, audit as never, agentWs as never, apps as never, links as never, appMoves as never, databases as never, backups as never, lease as never, carry as never);
  svc.pollMs = 0;
  return { svc, w, prisma, apps, links, appMoves, databases, backups, agentWs };
}

const planOf = (w: World) => parsePlan(w.move.plan);
const order = (w: World, ...prefixes: string[]) => prefixes.map((p) => w.calls.findIndex((c) => c.startsWith(p)));
const increasing = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));
/** The calls happened in this order (each exact call found after the one before; other calls may sit between). */
const inOrder = (w: World, ...calls: string[]): boolean => {
  let at = -1;
  for (const c of calls) {
    at = w.calls.indexOf(c, at + 1);
    if (at < 0) return false;
  }
  return true;
};

describe("ProjectMoveRunnerService: the good path", () => {
  it("copies the database, freezes its writer, moves each app, relinks, redeploys and sets the old database aside", async () => {
    const { svc, w } = make();
    await svc.run("pm1");
    expect(w.move.phase).toBe("COMPLETED");
    expect(increasing(order(w, "db.clone:d1", "db.moveToServer:d1copy:s2", "db.provision:d1copy", "app.stop:a1", "backup:d1", "restore:d1->d1copy", "link.remove:a1:l1", "appmove.start:a1", "link.create:a1:d1copy:DATABASE_URL", "app.deploy:a1", "appmove.start:a2", "db.stop:d1", "db.rename:d1"))).toBe(true);
    // the worker uses no database: no unlink, no extra deploy
    expect(w.calls.filter((c) => c.includes(":a2"))).toEqual(["appmove.start:a2"]);
    // the link now points at the copy, the old database is stopped and renamed, the copy runs on the target
    expect(w.links).toEqual([expect.objectContaining({ appId: "a1", databaseId: "d1copy", envVar: "DATABASE_URL" })]);
    expect(w.dbs.get("d1")).toMatchObject({ status: "STOPPED" });
    expect(String(w.dbs.get("d1")!.name)).toContain("before move");
    expect(w.dbs.get("d1copy")).toMatchObject({ serverId: "s2", status: "RUNNING", name: "main" });
    // safety copy window and report
    expect(w.move.archiveUntil).toBeInstanceOf(Date);
    expect(w.move.finishedAt).toBeInstanceOf(Date);
    const plan = planOf(w);
    expect(plan.report?.checks.every((c) => c.ok)).toBe(true);
    expect(plan.report?.dns).toEqual([{ hostname: "web.example.com", targetIp: "5.6.7.8", repointed: false }]);
    expect((w.move.items as Array<{ tempAddress: string; phase: string }>).map((i) => i.phase)).toEqual(["moved", "moved", "moved"]);
    expect((w.move.items as Array<{ tempAddress: string }>)[1].tempAddress).toBe("a1.sslip.io");
  });

  it("the app move is asked with the project's own options: target, acknowledgements, DNS flag, retention and the app's exact name", async () => {
    const { svc, appMoves } = make({ plan: { acks: { hostMounts: true } as never, repointDns: true } });
    await svc.run("pm1");
    expect(appMoves.start).toHaveBeenCalledWith("u1", "a1", { targetServerId: "s2", acknowledge: { hostMounts: true }, repointDns: false, archiveRetainDays: 7, confirmName: "web" });
  });

  it("a project with a database never deployed moves its configuration only: no copy, backup or restore", async () => {
    const { svc, w } = make({ items: "config-only" });
    await svc.run("pm1");
    expect(w.move.phase).toBe("COMPLETED");
    expect(w.calls).toContain("db.moveToServer:d1:s2");
    expect(w.calls.some((c) => c.startsWith("db.clone") || c.startsWith("backup") || c.startsWith("restore") || c.startsWith("db.stop"))).toBe(false);
    expect(w.dbs.get("d1")).toMatchObject({ serverId: "s2" });
  });

  it("a project with no database just moves its apps", async () => {
    const { svc, w } = make({ items: "plain", plan: { dbs: {} } });
    (w.move.items as unknown[]).splice(0, 1);
    await svc.run("pm1");
    expect(w.move.phase).toBe("COMPLETED");
    expect(w.calls).toEqual(["appmove.start:a1", "appmove.start:a2"]);
  });

  it("the stored plan, the items and the audit trail never hold a credential or a value", async () => {
    const { svc, w } = make();
    await svc.run("pm1");
    expect(JSON.stringify([w.move.plan, w.move.items, w.audits])).not.toContain(CANARY);
    expect(w.audits.map((a) => a.action)).toEqual(expect.arrayContaining(["project.move.phase", "project.move.complete"]));
  });
});

describe("ProjectMoveRunnerService: failure before any app moved rolls back by itself", () => {
  const rolledBack = (w: World, code: string) => {
    expect(w.move.phase).toBe("ROLLED_BACK");
    expect(w.move.failureReason).toBe(code);
    // the original database was never stopped, renamed or removed; the copy is gone; the app is linked to the source database again and running
    expect(w.calls.some((c) => c === "db.stop:d1" || c === "db.rename:d1" || c === "db.remove:d1")).toBe(false);
    expect(w.dbs.has("d1copy")).toBe(false);
    expect(w.links).toEqual([expect.objectContaining({ appId: "a1", databaseId: "d1", envVar: "DATABASE_URL" })]);
    expect(w.apps.get("a1")).toMatchObject({ status: "RUNNING", serverId: "s1" });
  };

  it("the copy does not come up", async () => {
    const { svc, w } = make({ failProvision: true });
    await svc.run("pm1");
    rolledBack(w, "db_copy_failed");
    expect(w.calls.some((c) => c.startsWith("backup") || c.startsWith("appmove"))).toBe(false);
  });

  it("the backup fails after the writer was frozen: the writer is started again", async () => {
    const { svc, w } = make({ failBackup: true });
    await svc.run("pm1");
    rolledBack(w, "db_backup_failed");
    expect(w.calls).toContain("app.stop:a1");
    expect(w.calls).toContain("app.start:a1");
    expect(w.calls.some((c) => c.startsWith("appmove") || c.startsWith("restore"))).toBe(false);
  });

  it("the restore fails; the error text never reaches the row", async () => {
    const { svc, w } = make({ failRestore: true });
    await svc.run("pm1");
    rolledBack(w, "db_restore_failed");
    expect(JSON.stringify([w.move, w.audits])).not.toContain(CANARY);
  });

  it("the first app's move rolls back by itself: links go back to the source database and the copy is removed", async () => {
    const { svc, w } = make({ appMovePhase: { a1: "ROLLED_BACK" } });
    await svc.run("pm1");
    rolledBack(w, "app_move_rolled_back");
    expect(w.calls).not.toContain("appmove.start:a2");
  });

  it("an agent that is offline at the start rolls back with nothing touched", async () => {
    const { svc, w } = make({ online: false });
    await svc.run("pm1");
    expect(w.move.phase).toBe("ROLLED_BACK");
    expect(w.move.failureReason).toBe("agent_offline");
    expect(w.calls).toEqual([]);
  });

  it("a cancel before the first app moves rolls the move back", async () => {
    const { svc, w } = make({ cancel: true });
    await svc.run("pm1");
    expect(w.move.phase).toBe("ROLLED_BACK");
    expect(w.move.failureReason).toBe("cancelled");
    expect(w.calls).toEqual([]);
  });
});

describe("ProjectMoveRunnerService: unlinking is recorded before it starts, so a half-done unlink is always undone", () => {
  /** The app has two links to the database; the second removal fails. */
  function twoLinks(o: Opts = {}) {
    const t = make(o);
    t.w.links.push({ id: "l2", appId: "a1", databaseId: "d1", envVar: "READ_URL" });
    return t;
  }

  it("the links, the network flag and the stage are stored BEFORE the first link is removed", async () => {
    const t = twoLinks();
    let seen: StoredPlan | null = null;
    const real = t.links.remove.getMockImplementation()!;
    t.links.remove.mockImplementation(async (u: string, appId: string, linkId: string) => {
      seen ??= JSON.parse(JSON.stringify(planOf(t.w))) as StoredPlan;
      return real(u, appId, linkId);
    });
    await t.svc.run("pm1");
    expect(seen!.apps.a1).toMatchObject({ stage: "unlinking", hadDbNetwork: true, links: [{ envVar: "DATABASE_URL", databaseId: "d1" }, { envVar: "READ_URL", databaseId: "d1" }] });
  });

  it("the second removal throws: the first removed link and the network flag are put back, the move ends ROLLED_BACK", async () => {
    const t = twoLinks();
    const real = t.links.remove.getMockImplementation()!;
    t.links.remove.mockImplementation(async (u: string, appId: string, linkId: string) => {
      if (linkId === "l2") throw new Error("db hiccup");
      return real(u, appId, linkId);
    });
    await t.svc.run("pm1");
    expect(t.w.move.phase).toBe("ROLLED_BACK");
    expect(t.w.links.map((l) => `${l.databaseId}:${l.envVar}`).sort()).toEqual(["d1:DATABASE_URL", "d1:READ_URL"]);
    expect(t.w.apps.get("a1")).toMatchObject({ dbNetwork: true, serverId: "s1", status: "RUNNING" });
    expect(t.w.dbs.has("d1copy")).toBe(false);
    expect(t.w.calls.some((c) => c === "db.stop:d1" || c === "db.remove:d1")).toBe(false);
  });

  it("a hub restart half-way through the removals continues with what is left, never re-reading the links as 'the' list", async () => {
    const t = twoLinks({
      plan: {
        dbs: { d1: { stage: "restored", configOnly: false, oldName: "main", targetDbId: "d1copy" } },
        apps: { a1: { stage: "unlinking", links: [{ envVar: "DATABASE_URL", databaseId: "d1" }, { envVar: "READ_URL", databaseId: "d1" }], hadDbNetwork: true, wasRunning: true }, a2: { stage: "pending", links: [], hadDbNetwork: false, wasRunning: false } },
        frozen: ["a1"],
      },
    });
    t.w.links = t.w.links.filter((l) => l.id !== "l1"); // the first removal already happened before the crash
    t.w.dbs.set("d1copy", { id: "d1copy", name: "main", status: "RUNNING", serverId: "s2" });
    t.w.restores.push({ databaseId: "d1copy", status: "SUCCESS" });
    t.w.move.phase = "MOVING";
    await t.svc.run("pm1");
    expect(t.w.calls.filter((c) => c.startsWith("link.remove"))).toEqual(["link.remove:a1:l2"]);
    expect(t.w.move.phase).toBe("COMPLETED");
    expect(t.w.links.map((l) => `${l.databaseId}:${l.envVar}`).sort()).toEqual(["d1copy:DATABASE_URL", "d1copy:READ_URL"]);
  });

  it("a crash during the removals then a failure: rollback covers an app in the unlinking stage", async () => {
    const t = twoLinks({
      plan: {
        dbs: { d1: { stage: "restored", configOnly: false, oldName: "main", targetDbId: "d1copy" } },
        apps: { a1: { stage: "unlinking", links: [{ envVar: "DATABASE_URL", databaseId: "d1" }, { envVar: "READ_URL", databaseId: "d1" }], hadDbNetwork: true, wasRunning: true }, a2: { stage: "pending", links: [], hadDbNetwork: false, wasRunning: false } },
        frozen: ["a1"],
      },
    });
    t.w.links = [];
    t.w.dbs.set("d1copy", { id: "d1copy", name: "main", status: "RUNNING", serverId: "s2" });
    t.w.move.phase = "ROLLING_BACK";
    await t.svc.run("pm1");
    expect(t.w.move.phase).toBe("ROLLED_BACK");
    expect(t.w.links.map((l) => l.envVar).sort()).toEqual(["DATABASE_URL", "READ_URL"]);
    expect(t.w.links.every((l) => l.databaseId === "d1")).toBe(true);
  });
});

describe("ProjectMoveRunnerService: a child app move that is still running is never rolled back under", () => {
  /** The first app's move stays active and the 12 hour deadline passes. */
  function stuck() {
    const t = make({ appMovePhase: { a1: "TRANSFERRING" } });
    const real = Date.now.bind(Date);
    let started = false;
    const start = t.appMoves.start.getMockImplementation()!;
    t.appMoves.start.mockImplementation(async (...a: Parameters<typeof start>) => {
      started = true;
      return start(...a);
    });
    let ticks = 0;
    jest.spyOn(Date, "now").mockImplementation(() => real() + (started ? ++ticks * 13 * 3600_000 : 0)); // every look at the clock after the start is 13 hours later
    return t;
  }
  afterEach(() => jest.restoreAllMocks());

  it("a timeout while the app move is active ends FAILED(timeout): the database copy and the links stay, the child is asked to cancel", async () => {
    const t = stuck();
    await t.svc.run("pm1");
    expect(t.w.move.phase).toBe("FAILED");
    expect(t.w.move.failureReason).toBe("timeout");
    expect(t.w.calls).toContain("appmove.cancel:a1:mv-a1");
    expect(t.w.calls.some((c) => c.startsWith("db.remove") || c === "db.stop:d1" || c === "db.rename:d1")).toBe(false);
    expect(t.w.dbs.has("d1copy")).toBe(true);
    expect(t.w.calls.some((c) => c.startsWith("link.create"))).toBe(false); // nothing is relinked behind a running child either
    expect(t.w.audits.find((a) => a.action === "project.move.fail")?.meta).toMatchObject({ code: "timeout", childActive: true });
  });

  it("a rollback that finds a child move still active refuses to remove anything and ends FAILED(rollback_incomplete)", async () => {
    const t = make({
      plan: {
        dbs: { d1: { stage: "restored", configOnly: false, oldName: "main", targetDbId: "d1copy" } },
        apps: { a1: { stage: "moving", moveId: "mv-a1", links: [{ envVar: "DATABASE_URL", databaseId: "d1" }], hadDbNetwork: true, wasRunning: true }, a2: { stage: "pending", links: [], hadDbNetwork: false, wasRunning: false } },
      },
    });
    t.w.appMoves.set("mv-a1", { id: "mv-a1", phase: "TRANSFERRING", plan: {} });
    t.w.dbs.set("d1copy", { id: "d1copy", name: "main", status: "RUNNING", serverId: "s2" });
    t.w.move.phase = "ROLLING_BACK";
    await t.svc.run("pm1");
    expect(t.w.move.phase).toBe("FAILED");
    expect(t.w.move.failureReason).toBe("rollback_incomplete");
    expect(t.w.dbs.has("d1copy")).toBe(true);
    expect(t.w.calls.some((c) => c.startsWith("db.remove"))).toBe(false);
  });

  it("a child that already ended (ROLLED_BACK) does not stop the normal rollback", async () => {
    const t = make({ appMovePhase: { a1: "ROLLED_BACK" } });
    await t.svc.run("pm1");
    expect(t.w.move.phase).toBe("ROLLED_BACK");
    expect(t.w.calls.some((c) => c.startsWith("appmove.cancel"))).toBe(false);
  });
});

describe("ProjectMoveRunnerService: failure after an app moved is never undone on its own", () => {
  it("the second app's move fails: the move ends FAILED, nothing is removed, relinked or restarted behind the owner's back", async () => {
    const { svc, w } = make({ appMovePhase: { a2: "FAILED" } });
    await svc.run("pm1");
    expect(w.move.phase).toBe("FAILED");
    expect(w.move.failureReason).toBe("app_move_failed");
    expect(w.calls.some((c) => c === "db.remove:d1copy" || c === "db.stop:d1" || c === "db.rename:d1")).toBe(false);
    expect(w.apps.get("a1")).toMatchObject({ serverId: "s2" });
    expect(w.links).toEqual([expect.objectContaining({ databaseId: "d1copy" })]); // a1 stays linked to the copy
    expect(w.dbs.has("d1copy")).toBe(true);
    const items = w.move.items as Array<{ name: string; phase: string }>;
    expect(items.find((i) => i.name === "web")?.phase).toBe("moved");
    expect(items.find((i) => i.name === "worker")?.phase).toBe("moving");
  });

  it("a cancel that arrives after an app moved is ignored: the move completes", async () => {
    const { svc, w, apps } = make();
    // cancel is requested once the first app has moved
    apps.deploy.mockImplementationOnce(async (_u: string, id: string) => {
      w.calls.push(`app.deploy:${id}`);
      w.apps.get(id)!.status = "RUNNING";
      w.move.cancelRequested = true;
    });
    await svc.run("pm1");
    expect(w.move.phase).toBe("COMPLETED");
  });

  it("a verification that finds an app not running ends FAILED (verify_failed) with the report saying which", async () => {
    const { svc, w } = make({ appStaysStopped: true });
    await svc.run("pm1");
    expect(w.move.phase).toBe("FAILED");
    expect(w.move.failureReason).toBe("verify_failed");
    const report = planOf(w).report!;
    expect(report.checks.filter((c) => !c.ok).map((c) => `${c.code}:${c.name}`)).toEqual(["app_running:web"]);
    expect(w.calls.some((c) => c.startsWith("db.remove"))).toBe(false);
  });
});

describe("ProjectMoveRunnerService: resuming after a restart does only what is left", () => {
  it("a database copy that was created and is already running is reused, not made again", async () => {
    const { svc, w } = make({ plan: { dbs: { d1: { stage: "created", configOnly: false, oldName: "main", targetDbId: "d1copy" } } } });
    w.dbs.set("d1copy", { id: "d1copy", name: "main", status: "RUNNING", serverId: "s2" });
    w.move.phase = "MOVING";
    await svc.run("pm1");
    expect(w.calls.filter((c) => c.startsWith("db.clone") || c.startsWith("db.provision"))).toEqual([]);
    expect(w.move.phase).toBe("COMPLETED");
  });

  it("an app move already started is waited for, not started twice; an app already moved is not moved again", async () => {
    const { svc, w } = make({
      items: "plain",
      plan: { dbs: {}, apps: { a1: { stage: "moving", moveId: "mv-a1", links: [], hadDbNetwork: false, wasRunning: true }, a2: { stage: "pending", links: [], hadDbNetwork: false, wasRunning: false } } },
    });
    (w.move.items as unknown[]).splice(0, 1);
    w.appMoves.set("mv-a1", { id: "mv-a1", phase: "COMPLETED", plan: {} });
    w.apps.get("a1")!.serverId = "s2";
    w.move.phase = "MOVING";
    await svc.run("pm1");
    expect(w.calls).toEqual(["appmove.start:a2"]);
    expect(w.move.phase).toBe("COMPLETED");
  });

  it("a move another process owns is left alone", async () => {
    const { svc, w } = make({ ownerId: "other-boot" });
    await svc.run("pm1");
    expect(w.move.phase).toBe("QUEUED");
    expect(w.calls).toEqual([]);
  });

  it("a finished move is not driven again", async () => {
    const { svc, w } = make({ moveRow: { phase: "COMPLETED" } });
    await svc.run("pm1");
    expect(w.calls).toEqual([]);
  });
});

describe("StepError", () => {
  it("carries only a fixed code", () => {
    expect(new StepError("db_copy_failed").message).toBe("db_copy_failed");
  });
});

describe("ProjectMoveRunnerService: a database's extra volumes travel with it", () => {
  const VOLS = [{ name: "ext", path: "/ext" }, { name: "wal", path: "/wal" }];
  it("stops both sides, copies each volume under the copy's own name, starts the copy again, then moves the apps", async () => {
    const { svc, w } = make({ extraVolumes: VOLS });
    await svc.run("pm1");
    expect(w.move.phase).toBe("COMPLETED");
    expect(inOrder(w, "restore:d1->d1copy", "db.stop:d1", "db.stop:d1copy", "carry:tugra_dbv_d1copy_ext", "carry:tugra_dbv_d1copy_wal", "db.provision:d1copy", "appmove.start:a1")).toBe(true);
    // the provision that follows the carry is the second one (the first made the copy)
    expect(w.calls.filter((c) => c === "db.provision:d1copy")).toHaveLength(2);
    expect(planOf(w).dbs.d1.volumesDone).toEqual(["ext", "wal"]);
    expect(w.dbs.get("d1copy")).toMatchObject({ status: "RUNNING" });
  });
  it("a database with no extra volumes is not stopped early and nothing is carried", async () => {
    const { svc, w } = make();
    await svc.run("pm1");
    expect(w.calls.some((c) => c.startsWith("carry:"))).toBe(false);
    expect(w.calls.filter((c) => c === "db.stop:d1")).toHaveLength(1); // only the set-aside at the end
  });
  it("a restart in the middle copies only the volumes that are left", async () => {
    const { svc, w } = make({ extraVolumes: VOLS, plan: { dbs: { d1: { stage: "restored", configOnly: false, oldName: "main", targetDbId: "d1copy", sourceStopped: true, volumesDone: ["ext"] } }, frozen: [] } });
    w.dbs.set("d1copy", { id: "d1copy", name: "main", status: "STOPPED", serverId: "s2" });
    w.move.phase = "MOVING";
    await svc.run("pm1");
    expect(w.calls.filter((c) => c.startsWith("carry:"))).toEqual(["carry:tugra_dbv_d1copy_wal"]);
    expect(w.calls).not.toContain("db.stop:d1copy"); // it was already stopped
  });
  it("a volume that cannot be carried rolls the move back by itself: the source database runs again, the copy is removed, no app moved", async () => {
    const { svc, w } = make({ extraVolumes: VOLS, failCarry: true });
    await svc.run("pm1");
    expect(w.move.phase).toBe("ROLLED_BACK");
    expect(w.move.failureReason).toBe("db_volume_failed");
    expect(inOrder(w, "db.stop:d1", "db.provision:d1", "db.remove:d1copy")).toBe(true);
    expect(w.calls.some((c) => c.startsWith("appmove.start"))).toBe(false);
    expect(w.dbs.get("d1")).toMatchObject({ status: "RUNNING" });
    expect(w.apps.get("a1")).toMatchObject({ status: "RUNNING", serverId: "s1" });
  });
  it("an agent that goes away during the copy is an agent failure, not a volume failure", async () => {
    const { svc, w } = make({ extraVolumes: VOLS });
    const { VolumeCarryError: E } = await import("./project-move-volume-carry.service");
    (svc as unknown as { carry: { carry: jest.Mock } }).carry.carry.mockRejectedValueOnce(new E("agent_offline"));
    await svc.run("pm1");
    expect(w.move.failureReason).toBe("agent_offline");
  });
});

describe("ProjectMoveRunnerService: the owner's undo of a partly moved project", () => {
  /** a1 (with its database) moved to s2 and runs on the copy; a2 never moved; the move ended FAILED and the owner asked to undo it. */
  function partial(extra: Partial<Opts> = {}) {
    const t = make({
      ...extra,
      plan: {
        ownerRollback: true,
        frozen: ["a1", "a2"],
        dbs: { d1: { stage: "restored", configOnly: false, oldName: "main", targetDbId: "d1copy", backupId: "b0" } },
        apps: {
          a1: { stage: "redeployed", moveId: "mv-a1", links: [{ envVar: "DATABASE_URL", databaseId: "d1" }], hadDbNetwork: true, wasRunning: true },
          a2: { stage: "pending", links: [], hadDbNetwork: false, wasRunning: false },
          ...(extra.plan?.apps ?? {}),
        },
        ...(extra.plan ?? {}),
      },
      moveRow: { phase: "ROLLING_BACK", failureReason: "app_move_failed", ...(extra.moveRow ?? {}) },
    });
    const { w } = t;
    w.apps.get("a1")!.serverId = "s2";
    w.apps.get("a1")!.status = "RUNNING";
    w.apps.get("a2")!.status = "STOPPED";
    w.dbs.set("d1copy", { id: "d1copy", name: "main", status: "RUNNING", serverId: "s2" });
    w.links.length = 0;
    w.links.push({ id: "l9", appId: "a1", databaseId: "d1copy", envVar: "DATABASE_URL" });
    w.appMoves.set("mv-a1", { id: "mv-a1", phase: "COMPLETED", plan: {} });
    return t;
  }

  it("stops the app, brings the database up to date on the source, moves the app back, links it to the source again, starts the rest and removes the copy last", async () => {
    const { svc, w } = partial();
    await svc.run("pm1");
    expect(w.move.phase).toBe("ROLLED_BACK");
    expect(w.move.failureReason).toBe("rolled_back_by_owner");
    expect(inOrder(w, "app.stop:a1", "link.remove:a1:l9", "backup:d1copy", "restore:d1copy->d1", "appmove.start:a1", "link.create:a1:d1:DATABASE_URL", "app.deploy:a1", "app.start:a2", "db.remove:d1copy")).toBe(true);
    // the app is back on the source, linked to the SOURCE database, which runs and has its own name; the copy is gone
    expect(w.apps.get("a1")).toMatchObject({ serverId: "s1", status: "RUNNING" });
    expect(w.links).toEqual([expect.objectContaining({ appId: "a1", databaseId: "d1", envVar: "DATABASE_URL" })]);
    expect(w.dbs.has("d1copy")).toBe(false);
    expect(w.dbs.get("d1")).toMatchObject({ status: "RUNNING", serverId: "s1" });
    // the app that never moved is just started again
    expect(w.apps.get("a2")).toMatchObject({ status: "RUNNING", serverId: "s1" });
    // the app move that brings the app back targets the SOURCE, with the app's exact name
    expect(w.calls).toContain("appmove.start:a1");
    expect(planOf(w).undo?.apps.a1.stage).toBe("done");
    expect(planOf(w).undo?.dbs.d1.stage).toBe("copy_removed");
  });

  it("the audit trail says the owner undid it; the plan holds no value", async () => {
    const { svc, w } = partial();
    await svc.run("pm1");
    expect(w.audits.some((a) => a.action === "project.move.rolled_back" && a.meta?.byOwner === true)).toBe(true);
    expect(JSON.stringify(w.move.plan) + JSON.stringify(w.audits)).not.toContain(CANARY);
  });

  it("a source database that was set aside is started again and gets its old name back", async () => {
    const t = partial({ plan: { dbs: { d1: { stage: "source_stopped", configOnly: false, oldName: "main", targetDbId: "d1copy", setAside: true } } } as never });
    t.w.dbs.get("d1")!.status = "STOPPED";
    t.w.dbs.get("d1")!.name = "main (before move abc123)";
    await t.svc.run("pm1");
    expect(t.w.move.phase).toBe("ROLLED_BACK");
    expect(inOrder(t.w, "db.provision:d1", "backup:d1copy", "restore:d1copy->d1", "db.rename:d1")).toBe(true);
    expect(t.w.dbs.get("d1")).toMatchObject({ status: "RUNNING", name: "main" });
  });

  it("when no app ever wrote to the copy nothing is copied back: the source simply keeps its data", async () => {
    const t = partial({ plan: { apps: { a1: { stage: "moved", moveId: "mv-a1", links: [{ envVar: "DATABASE_URL", databaseId: "d1" }], hadDbNetwork: true, wasRunning: true } } } as never });
    await t.svc.run("pm1");
    expect(t.w.move.phase).toBe("ROLLED_BACK");
    expect(t.w.calls.some((c) => c.startsWith("backup:") || c.startsWith("restore:"))).toBe(false);
  });

  it("a database copy is not removed while an app that moved is still away from the source", async () => {
    const t = partial({ moveRow: {} });
    t.appMoves.start.mockImplementationOnce(async (_u: string, appId: string) => {
      t.w.calls.push(`appmove.start:${appId}`);
      t.w.appMoves.set("mv-a1", { id: "mv-a1", phase: "ROLLED_BACK", plan: {} });
      return { moveId: "mv-a1", phase: "QUEUED" };
    });
    await t.svc.run("pm1");
    expect(t.w.move.phase).toBe("FAILED");
    expect(t.w.move.failureReason).toBe("rollback_incomplete");
    expect(t.w.calls.some((c) => c.startsWith("db.remove"))).toBe(false);
    expect(t.w.apps.get("a1")).toMatchObject({ serverId: "s2" });
  });

  it("pressing it again after a failed step continues from the stored stages: the app is not stopped or moved twice", async () => {
    const t = partial();
    t.backups.restoreTo.mockRejectedValueOnce(new Error(`pg said ${CANARY}`));
    await t.svc.run("pm1");
    expect(t.w.move.phase).toBe("FAILED");
    expect(t.w.move.failureReason).toBe("rollback_incomplete");
    const stopsBefore = t.w.calls.filter((c) => c === "app.stop:a1").length;
    // the owner presses it again: the same state the service writes
    t.w.move.phase = "ROLLING_BACK";
    t.w.move.ownerId = null;
    await t.svc.run("pm1");
    expect(t.w.move.phase).toBe("ROLLED_BACK");
    expect(t.w.calls.filter((c) => c === "app.stop:a1").length).toBe(stopsBefore);
    expect(t.w.calls.filter((c) => c === "appmove.start:a1")).toHaveLength(1);
    expect(JSON.stringify(t.w.move.plan) + JSON.stringify(t.w.audits)).not.toContain(CANARY);
  });

  it("an agent that goes away leaves it FAILED as an agent failure so the owner can press it again", async () => {
    const { AgentOfflineException } = await import("../agent-gateway/agent-offline.exception");
    const t = partial();
    t.appMoves.start.mockRejectedValueOnce(new AgentOfflineException("s2"));
    await t.svc.run("pm1");
    expect(t.w.move.phase).toBe("FAILED");
    expect(t.w.move.failureReason).toBe("rollback_incomplete");
  });
});

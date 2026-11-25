import { ProjectMoveRunnerService, StepError } from "./project-move-runner.service";
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
  w.dbs.set("d1", { id: "d1", name: "main", status: kind === "config-only" ? "NEW" : "RUNNING", serverId: "s1" });
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
  const lease = { bootId: "boot1" };
  const svc = new ProjectMoveRunnerService(prisma as never, audit as never, agentWs as never, apps as never, links as never, appMoves as never, databases as never, backups as never, lease as never);
  svc.pollMs = 0;
  return { svc, w, prisma, apps, links, appMoves, databases, backups, agentWs };
}

const planOf = (w: World) => parsePlan(w.move.plan);
const order = (w: World, ...prefixes: string[]) => prefixes.map((p) => w.calls.findIndex((c) => c.startsWith(p)));
const increasing = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));

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

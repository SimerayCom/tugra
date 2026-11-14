import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { RolloutsService } from "./rollouts.service";
import { RolloutEngineService } from "./rollout-engine.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";

jest.mock("../common/resource-project", () => ({
  loadProjectCtx: jest.fn(async (_p: unknown, envId: string) => ({ projectId: envId === "env-secret" ? "proj-secret" : "proj-public", projectName: null, environmentName: null })),
  loadProjectCtxMany: jest.fn(async (_p: unknown, envIds: string[]) => new Map(envIds.map((e) => [e, { projectId: e === "env-secret" ? "proj-secret" : "proj-public", projectName: null, environmentName: null }]))),
}));

const app = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  teamId: "t1",
  name: id,
  serverId: "s1",
  status: "RUNNING",
  clusterId: null,
  source: "GIT",
  rollbackOnFailure: true,
  healthCheckType: null,
  imagesToKeep: null,
  autoDeploy: false,
  environmentId: "env1",
  ...over,
});

function make(opts: { apps?: ReturnType<typeof app>[]; busy?: string[]; rollout?: Record<string, unknown>; perms?: string[]; member?: boolean; scoped?: { projects: string[] }; createThrows?: unknown } = {}) {
  const apps = opts.apps ?? [app("app1"), app("app2"), app("app3")];
  const rolloutRow = {
    id: "r1",
    teamId: "t1",
    createdBy: "u1",
    name: null,
    kind: "app_deploy",
    status: "RUNNING",
    haltReason: null,
    haltDetail: null,
    config: { canary: 1, steps: [25, 50, 100] },
    currentWave: 0,
    waveCount: 2,
    waveStartedAt: new Date(),
    bakeUntil: null,
    createdAt: new Date(),
    finishedAt: null,
    updatedAt: new Date(),
    ...opts.rollout,
  };
  const targetRows: Array<Record<string, unknown>> = [
    { id: "ta", rolloutId: "r1", wave: 0, position: 0, kind: "app_deploy", resourceId: "app1", serverId: "s1", label: "app1", status: "FAILED", attempt: 1, baselineDeploymentId: null, deploymentId: "d1", outcome: "failed", detail: null, active: true, dispatchedAt: null, finishedAt: null },
    { id: "tb", rolloutId: "r1", wave: 1, position: 1, kind: "app_deploy", resourceId: "app2", serverId: "s1", label: "app2", status: "PENDING", attempt: 0, baselineDeploymentId: null, deploymentId: null, outcome: null, detail: null, active: true, dispatchedAt: null, finishedAt: null },
  ];
  const created: Array<Record<string, unknown>> = [];
  const rollout = {
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      if (opts.createThrows) throw opts.createThrows;
      created.push(args.data);
      return { ...rolloutRow, ...args.data, id: "new1" };
    }),
    findUniqueOrThrow: jest.fn(async () => ({ ...rolloutRow, id: "new1", waveCount: 3, targets: [] })),
    findUnique: jest.fn(async () => ({ ...rolloutRow, targets: targetRows })),
    findMany: jest.fn(async () => [{ ...rolloutRow, targets: targetRows }]),
    updateMany: jest.fn(async (args: { where: { status: unknown }; data: Record<string, unknown> }) => {
      const want = args.where.status as string | { in: string[] };
      const ok = typeof want === "string" ? rolloutRow.status === want : want.in.includes(rolloutRow.status as string);
      if (ok) Object.assign(rolloutRow, args.data);
      return { count: ok ? 1 : 0 };
    }),
  };
  const rolloutTarget = {
    createMany: jest.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })),
    findMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
      if ("active" in args.where) return (opts.busy ?? []).map((id) => ({ resourceId: id }));
      return targetRows.filter((t) => t.status === "DEPLOYING");
    }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const base = {
    application: { findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) => apps.filter((a) => args.where.id.in.includes(a.id))) },
    rolloutTarget,
    rollout,
  };
  const prisma = { ...base, $transaction: jest.fn(async (cb: (t: typeof base) => unknown) => cb(base)) } as unknown as PrismaService;
  const perms = new Set(opts.perms ?? ["apps:deploy"]);
  const membership = opts.member === false ? null : opts.scoped
    ? { teamId: "t1", role: "VIEWER", teamRoleId: null, restrictedAccess: true, accessedProjects: opts.scoped.projects, accessedResources: [] }
    : { teamId: "t1", role: "ADMIN", teamRoleId: null, restrictedAccess: false, accessedProjects: [], accessedResources: [] };
  const access = {
    requirePermission: jest.fn(async (_u: string, _t: string, p: string) => {
      if (!perms.has(p)) throw new ForbiddenException("missing " + p);
    }),
    requireResourceAccess: jest.fn().mockResolvedValue(undefined),
    permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", perms]])),
    accessByTeam: jest.fn().mockResolvedValue(new Map(membership ? [["t1", membership]] : [])),
    membershipAccess: jest.fn().mockResolvedValue(membership),
    teamRole: jest.fn().mockResolvedValue(opts.member === false ? null : "MEMBER"),
  } as unknown as TeamAccessService;
  const audit = jest.fn().mockResolvedValue(undefined);
  const engine = { advance: jest.fn().mockResolvedValue(undefined), halt: jest.fn().mockResolvedValue(true), cancelQueued: jest.fn().mockResolvedValue(true) } as unknown as RolloutEngineService;
  const svc = new RolloutsService(prisma, access, { log: audit } as unknown as AuditService, engine);
  return { svc, prisma, access, audit, engine, tx: base, created, rolloutRow, targetRows };
}

describe("RolloutsService.create / plan", () => {
  it("all-or-nothing: an unknown or foreign app id refuses the whole rollout (403, no existence leak)", async () => {
    const m = make();
    await expect(m.svc.create("u1", { appIds: ["app1", "nope"], config: {} as never })).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.tx.rollout.create).not.toHaveBeenCalled();
  });
  it("requires apps:deploy on the team AND the caller's per-resource access for EVERY app; apps must share one team", async () => {
    const noPerm = make({ perms: [] });
    await expect(noPerm.svc.create("u1", { appIds: ["app1"], config: {} as never })).rejects.toBeInstanceOf(ForbiddenException);
    const two = make({ apps: [app("app1"), app("app2", { teamId: "t2" })] });
    await expect(two.svc.create("u1", { appIds: ["app1", "app2"], config: {} as never })).rejects.toBeInstanceOf(BadRequestException);
    const m = make();
    await m.svc.create("u1", { appIds: ["app1", "app2", "app3"], config: { canary: 1, steps: [100] } as never });
    expect(m.access.requireResourceAccess).toHaveBeenCalledTimes(3);
  });
  it("preflight blocks swarm / ungated / busy apps with a 422 naming them; plan() reports them without persisting", async () => {
    const m = make({ apps: [app("app1"), app("app2", { clusterId: "c1" }), app("app3", { source: "COMPOSE" })], busy: ["app1"] });
    const err = await m.svc.create("u1", { appIds: ["app1", "app2", "app3"], config: {} as never }).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({
      blocked: [
        { appId: "app1", reason: "in_other_rollout" },
        { appId: "app2", reason: "swarm_unsupported" },
        { appId: "app3", reason: "ungated" },
      ],
    });
    const plan = await m.svc.plan("u1", { appIds: ["app1", "app2", "app3"], config: {} as never });
    expect(plan.blocked).toBe(3);
    expect(plan.waveSizes).toEqual([]);
    expect(m.tx.rollout.create).not.toHaveBeenCalled();
    // allowUngated lets the compose app in (its own gate is weaker — the operator opted in)
    const ok = await m.svc.plan("u1", { appIds: ["app3"], config: { allowUngated: true } as never });
    expect(ok.targets[0]).toMatchObject({ wave: 0, blocked: null });
  });
  it("persists the plan (rollout + one target per app, caller order = wave order) in one transaction, audits, and kicks the engine", async () => {
    const m = make();
    await m.svc.create("u1", { appIds: ["app3", "app1", "app2"], name: "v2", config: { canary: 1, steps: [100] } as never });
    expect(m.created[0]).toMatchObject({ teamId: "t1", createdBy: "u1", name: "v2", waveCount: 2 });
    const data = (m.tx.rolloutTarget.createMany as jest.Mock).mock.calls[0][0].data as Array<{ resourceId: string; wave: number; position: number }>;
    expect(data.map((d) => [d.resourceId, d.wave, d.position])).toEqual([
      ["app3", 0, 0],
      ["app1", 1, 1],
      ["app2", 1, 2],
    ]);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "rollout.create", target: "new1" }));
    expect(m.engine.advance).toHaveBeenCalledWith("new1");
  });
  it("a lost race on the one-live-rollout-per-app index becomes a 409", async () => {
    const m = make({ createThrows: new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }) });
    await expect(m.svc.create("u1", { appIds: ["app1"], config: {} as never })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("RolloutsService — read + transitions", () => {
  it("get/list need team membership; the view summarises targets and computes wave sizes", async () => {
    const m = make();
    const v = await m.svc.get("u1", "r1");
    expect(v.summary).toMatchObject({ total: 2, failed: 1, pending: 1 });
    expect(v.waveSizes).toEqual([1, 1]);
    await expect(make({ member: false }).svc.get("u1", "r1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(await m.svc.list("u1", {})).toHaveLength(1);
    expect(await m.svc.list("u1", { teamId: "other" })).toEqual([]);
  });
  it("a scoped (restricted) member only sees rollouts whose apps are ALL in their granted projects; get() is a 404, never a 403, otherwise", async () => {
    // app2 lives in the secret project
    const apps = [app("app1"), app("app2", { environmentId: "env-secret" }), app("app3")];
    const canSee = make({ apps, scoped: { projects: ["proj-public", "proj-secret"] } });
    expect(await canSee.svc.list("u1", {})).toHaveLength(1);
    await expect(canSee.svc.get("u1", "r1")).resolves.toBeTruthy();
    const cannot = make({ apps, scoped: { projects: ["proj-public"] } });
    expect(await cannot.svc.list("u1", {})).toEqual([]);
    await expect(cannot.svc.get("u1", "r1")).rejects.toBeInstanceOf(NotFoundException);
    // a non-member is a 403
    await expect(make({ member: false }).svc.get("u1", "r1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("halt goes through the engine (RUNNING only); resume resets the wave's failed/cancelled/offline targets BEFORE flipping to RUNNING, in one transaction, and the resumer takes over as initiator", async () => {
    const m = make();
    await m.svc.halt("u1", "r1");
    expect(m.engine.halt).toHaveBeenCalledWith("r1", "manual", { by: "u1" }, "u1");

    const halted = make({ rollout: { status: "HALTED", haltReason: "wave_failed" } });
    await halted.svc.resume("u2", "r1");
    expect(halted.prisma.$transaction).toHaveBeenCalled();
    const resetOrder = (halted.tx.rolloutTarget.updateMany as jest.Mock).mock.invocationCallOrder[0];
    const flipOrder = (halted.tx.rollout.updateMany as jest.Mock).mock.invocationCallOrder[0];
    expect(resetOrder).toBeLessThan(flipOrder);
    const reset = (halted.tx.rolloutTarget.updateMany as jest.Mock).mock.calls[0][0];
    expect(reset.where).toMatchObject({ rolloutId: "r1", wave: 0, OR: [{ status: { in: ["FAILED", "CANCELLED"] } }, { status: "SKIPPED", outcome: "offline" }] });
    expect(reset.data).toMatchObject({ status: "PENDING", deploymentId: null, outcome: null, dispatchedAt: null });
    expect(halted.rolloutRow).toMatchObject({ status: "RUNNING", haltReason: null, createdBy: "u2" });
    // the resumer must reach every target app (all-or-nothing, like create)
    expect(halted.access.requireResourceAccess).toHaveBeenCalledTimes(2);
    expect(halted.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "rollout.resume", meta: expect.objectContaining({ takeover: true }) }));
    expect(halted.engine.advance).toHaveBeenCalledWith("r1");
    // resume from RUNNING is a 409
    await expect(m.svc.resume("u1", "r1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("resume after a FAILED BAKE promotes past the bake (the wave had passed): next wave, or COMPLETED on the last wave with the slots released", async () => {
    const mid = make({ rollout: { status: "HALTED", haltReason: "bake_failed", currentWave: 0, waveCount: 2 } });
    await mid.svc.resume("u1", "r1");
    expect(mid.tx.rolloutTarget.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PENDING" }) }));
    expect(mid.rolloutRow).toMatchObject({ status: "RUNNING", currentWave: 1 });
    const last = make({ rollout: { status: "HALTED", haltReason: "bake_failed", currentWave: 1, waveCount: 2 } });
    await last.svc.resume("u1", "r1");
    expect(last.rolloutRow).toMatchObject({ status: "COMPLETED" });
    expect(last.tx.rolloutTarget.updateMany).toHaveBeenCalledWith({ where: { rolloutId: "r1" }, data: { active: false } });
  });

  it("cancel flips status, skips PENDING and releases the slots in ONE transaction, then cancels still-queued deploys (their targets CANCELLED) and leaves running ones to settle later", async () => {
    const c = make();
    c.targetRows.push({ id: "tc", rolloutId: "r1", wave: 0, position: 2, kind: "app_deploy", resourceId: "app3", serverId: "s1", label: "app3", status: "DEPLOYING", attempt: 1, baselineDeploymentId: null, deploymentId: "dq", outcome: null, detail: null, active: true, dispatchedAt: null, finishedAt: null });
    c.targetRows.push({ id: "td", rolloutId: "r1", wave: 0, position: 3, kind: "app_deploy", resourceId: "app4", serverId: "s1", label: "app4", status: "DEPLOYING", attempt: 1, baselineDeploymentId: null, deploymentId: "dr", outcome: null, detail: null, active: true, dispatchedAt: null, finishedAt: null });
    (c.engine.cancelQueued as jest.Mock).mockImplementation(async (id: string) => id === "dq"); // dr already started
    await c.svc.cancel("u1", "r1");
    const calls = (c.tx.rolloutTarget.updateMany as jest.Mock).mock.calls.map((x) => x[0]);
    expect(calls[0]).toMatchObject({ where: { rolloutId: "r1", status: "PENDING" }, data: { status: "SKIPPED", outcome: "cancelled" } });
    expect(calls[1]).toMatchObject({ where: { rolloutId: "r1" }, data: { active: false } });
    expect(calls[2]).toMatchObject({ where: { id: "tc", status: "DEPLOYING" }, data: { status: "CANCELLED", outcome: "cancelled" } });
    expect(calls).toHaveLength(3); // td (running) untouched: the tick settles it when its deploy finishes
    expect(c.rolloutRow.status).toBe("CANCELLED");
    await expect(make({ rollout: { status: "COMPLETED" } }).svc.cancel("u1", "r1")).rejects.toBeInstanceOf(ConflictException);
  });
  it("transitions require apps:deploy", async () => {
    const m = make({ perms: [] });
    await expect(m.svc.halt("u1", "r1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.svc.cancel("u1", "r1")).rejects.toBeInstanceOf(ForbiddenException);
  });
});

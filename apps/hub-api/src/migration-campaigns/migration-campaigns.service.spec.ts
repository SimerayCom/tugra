import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { MigrationCampaignsService, runBody } from "./migration-campaigns.service";
import { CampaignCreateSchema, CampaignPlanSchema, CampaignViewsQuerySchema } from "./dto";
import type { CampaignFacts } from "./campaign-facts.service";
import type { PlacementHostFact } from "./campaign-plan";
import type { RunActor } from "../migration-runs/core/run-contract";

const actor: RunActor = { userId: "u1", scopes: ["*"], channel: "session" } as RunActor;
const HASH = "a".repeat(32);
/** The apps of the plan the specs rebuild: two on the in-place server `a`, one on `b`. */
const APPS = ["app:a:one", "app:a:two", "app:b:three"];

const host = (ref: string, o: Partial<PlacementHostFact> = {}): PlacementHostFact => ({ ref, name: ref, controlPlane: false, matchStatus: "certain", linkedBy: "auto", evidence: [], matchedServerId: `srv-${ref}`, agentOnline: true, ...o });
function factsOf(hosts: PlacementHostFact[], extra: string[] = ["new1"], teams: Record<string, string> = {}): CampaignFacts {
  const targets = new Map<string, { id: string; teamId: string; ready: boolean }>();
  for (const h of hosts) if (h.matchedServerId) targets.set(h.matchedServerId, { id: h.matchedServerId, teamId: teams[h.matchedServerId] ?? "t1", ready: true });
  for (const e of extra) targets.set(e, { id: e, teamId: teams[e] ?? "t1", ready: true });
  return { planHash: HASH, hosts, targets, appRefs: new Set(APPS), plan: { items: APPS.map((itemRef) => ({ itemRef, kind: "app", name: itemRef.split(":")[2] })) } };
}

function build(o: { startRefusal?: Record<string, "takeover_server_busy" | "takeover_tugra_proxy_in_use">; items?: Array<{ itemRef: string; kind: string; name: string }>; hosts?: PlacementHostFact[]; role?: Role | null; roles?: Record<string, Role>; createFails?: number; labelTaken?: boolean; labelTakenIn?: string; teams?: Record<string, string>; extra?: string[] } = {}) {
  const rows: Array<Record<string, unknown>> = [];
  const self: { db?: unknown } = {};
  const prisma = {
    // an interactive transaction: what it wrote is undone when it throws
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const before = rows.length;
      try {
        return await fn(self.db);
      } catch (e) {
        rows.length = before;
        throw e;
      }
    }),
    migrationCampaign: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (o.labelTaken || (o.labelTakenIn && data.teamId === o.labelTakenIn)) throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
        const r = { id: `camp${rows.length + 1}`, createdAt: new Date("2026-11-26T10:00:00Z"), ...data };
        rows.push(r);
        return r;
      }),
      update: jest.fn(async ({ data }: { where?: { id: string }; data: Record<string, unknown> }) => ({ ...rows[0], ...data })),
      findUnique: jest.fn(async () => rows[0] ?? null),
      findMany: jest.fn(async () => rows),
    },
    migrationRun: { findMany: jest.fn(async () => [{ id: "run1", status: "QUEUED" }, { id: "run2", status: "QUEUED" }]) },
  };
  self.db = prisma;
  const access = {
    requireRole: jest.fn(async (_u: unknown, teamId: string) => {
      const role = o.roles?.[teamId] ?? o.role;
      if (role === undefined || role === Role.OWNER) return;
      throw new ForbiddenException("insufficient role for this team");
    }),
    teamRole: jest.fn(async () => (o.role === undefined ? Role.OWNER : o.role)),
  };
  const audit = { log: jest.fn(async (..._a: unknown[]) => undefined) };
  const facts = {
    read: jest.fn(async (..._a: unknown[]) => {
      const f = factsOf(o.hosts ?? [host("a"), host("b")], o.extra ?? ["new1"], o.teams ?? {});
      return o.items ? { ...f, plan: { items: o.items } } : f;
    }),
  };
  const inplace = { startRefusal: jest.fn(async (_u: string, serverId: string) => o.startRefusal?.[serverId] ?? null) };
  let n = 0;
  const runs = {
    create: jest.fn(async (..._a: unknown[]) => {
      n += 1;
      if (o.createFails && n === o.createFails) throw new UnprocessableEntityException("target-offline");
      return { id: `run${n}` };
    }),
    abort: jest.fn(async (..._a: unknown[]) => ({})),
  };
  const svc = new MigrationCampaignsService(prisma as never, access as never, audit as never, facts as never, runs as never, inplace as never);
  return { svc, prisma, access, audit, facts, runs, rows, inplace };
}

const input = (over: Record<string, unknown> = {}) =>
  CampaignCreateSchema.parse({
    sessionId: "s1",
    planHash: HASH,
    confirm: 2,
    placements: [
      { sourceServerRef: "a", kind: "in-place" },
      { sourceServerRef: "b", kind: "other-server", targetServerId: "new1" },
    ],
    ...over,
  });

describe("MigrationCampaignsService.create", () => {
  it("creates the campaign and one run per planned run, carrying the label and a scope of its own servers", async () => {
    const t = build();
    const v = await t.svc.create(actor, input({ label: "wave-one" }));
    expect(v.runIds).toEqual(["run1", "run2"]);
    expect(v.status).toBe("draft");
    expect(v.label).toBe("wave-one");
    const bodies = t.runs.create.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ topology: "two-box", targetServerId: "new1", campaign: "wave-one", scope: { sourceServers: ["b"] } });
    expect(bodies[1]).toMatchObject({ topology: "swap-proxy", targetServerId: "srv-a", campaign: "wave-one", scope: { sourceServers: ["a"] } });
    expect(bodies.every((b) => b.sessionId === "s1" && b.planHash === HASH && b.sourceKind === "coolify")).toBe(true);
  });
  it("only the in-place wave is created as an in-place takeover (no data copy, no build): the flag goes in the hub's own argument, never in the request body", async () => {
    const t = build();
    await t.svc.create(actor, input());
    const calls = t.runs.create.mock.calls as unknown as Array<[unknown, Record<string, unknown>, { inPlace?: boolean } | undefined]>;
    expect(calls[0][1].topology).toBe("two-box");
    expect(calls[0][2]).toBeUndefined();
    expect(calls[1][1].topology).toBe("swap-proxy");
    expect(calls[1][2]).toEqual({ inPlace: true });
    expect(calls.every((c) => !("inPlace" in c[1]))).toBe(true);
  });
  it("rebuild choices go to the in-place run of their own server only; the copied run and a campaign without choices carry none", async () => {
    const t = build();
    await t.svc.create(actor, input({ rebuild: ["app:a:two", "app:a:one"] }));
    const bodies = t.runs.create.mock.calls.map((c) => c[1] as { options: Record<string, unknown> });
    expect(bodies[0].options).not.toHaveProperty("rebuild");
    expect(bodies[1].options.rebuild).toEqual(["app:a:two", "app:a:one"]);
    const plain = build();
    await plain.svc.create(actor, input());
    expect((plain.runs.create.mock.calls as unknown as Array<[unknown, { options: Record<string, unknown> }]>).every((c) => !("rebuild" in c[1].options))).toBe(true);
    expect((t.audit.log.mock.calls[0][0] as { meta: Record<string, unknown> }).meta.rebuild).toBe(2);
    expect(JSON.stringify(t.audit.log.mock.calls[0][0])).not.toContain("app:a:");
  });
  it("a rebuild choice on a server that is copied is a 422 and nothing is written", async () => {
    const t = build();
    await expect(t.svc.create(actor, input({ rebuild: ["app:a:one", "app:b:three"] }))).rejects.toMatchObject({ response: { code: "placement_rebuild_not_in_place", ref: "app:b:three" } });
    expect(t.prisma.migrationCampaign.create).not.toHaveBeenCalled();
    expect(t.runs.create).not.toHaveBeenCalled();
  });
  it("a rebuild choice the plan has no app for is a 422 and nothing is written", async () => {
    const t = build();
    await expect(t.svc.create(actor, input({ rebuild: ["app:a:ghost"] }))).rejects.toMatchObject({ response: { code: "placement_rebuild_unknown_item" } });
    expect(t.runs.create).not.toHaveBeenCalled();
  });
  it("the list is a field of the campaign, not of the shared options", async () => {
    const t = build();
    await expect(t.svc.create(actor, input({ options: { rebuild: ["app:a:one"] } }))).rejects.toBeInstanceOf(BadRequestException);
    expect(t.prisma.migrationCampaign.create).not.toHaveBeenCalled();
  });
  it("checks owner on the team of the targets and audits the creation with counts only", async () => {
    const t = build();
    await t.svc.create(actor, input());
    expect(t.access.requireRole).toHaveBeenCalledWith("u1", "t1", [Role.OWNER]);
    const call = t.audit.log.mock.calls[0][0] as { action: string; meta: Record<string, unknown> };
    expect(call.action).toBe("migration.campaign.create");
    expect(call.meta).toMatchObject({ runs: 2, servers: 2, inPlace: 1 });
    expect(JSON.stringify(call)).not.toContain("srv-a");
  });
  it("a team admin cannot create a campaign and nothing is written", async () => {
    const t = build({ role: Role.ADMIN });
    await expect(t.svc.create(actor, input())).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.prisma.migrationCampaign.create).not.toHaveBeenCalled();
    expect(t.runs.create).not.toHaveBeenCalled();
  });
  it("the typed count must match the number of source servers", async () => {
    const t = build();
    await expect(t.svc.create(actor, input({ confirm: 5 }))).rejects.toBeInstanceOf(BadRequestException);
    expect(t.facts.read).not.toHaveBeenCalled();
  });
  it("a locked in-place choice is a 422 with the reason, before anything is written", async () => {
    const t = build({ hosts: [host("a", { controlPlane: true }), host("b")] });
    await expect(t.svc.create(actor, input())).rejects.toMatchObject({ response: { code: "placement_in_place_locked", reason: "control_plane", ref: "a" } });
    expect(t.prisma.migrationCampaign.create).not.toHaveBeenCalled();
  });
  it("a taken label is a 409", async () => {
    const t = build({ labelTaken: true });
    await expect(t.svc.create(actor, input({ label: "x" }))).rejects.toBeInstanceOf(ConflictException);
    expect(t.runs.create).not.toHaveBeenCalled();
  });
  it("a run that fails to create aborts the runs made before it and cancels the campaign", async () => {
    const t = build({ createFails: 2 });
    await expect(t.svc.create(actor, input())).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(t.runs.abort).toHaveBeenCalledTimes(1);
    expect(t.runs.abort).toHaveBeenCalledWith(actor, "run1", { confirmName: "run1" });
    expect(t.prisma.migrationCampaign.update).toHaveBeenCalledWith({ where: { id: "camp1" }, data: { status: "cancelled" } });
    expect(t.audit.log.mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual(["migration.campaign.create", "migration.campaign.cancel"]);
  });
  it("a stale plan from the facts read is passed through as the 409 it is", async () => {
    const t = build();
    t.facts.read.mockRejectedValueOnce(new ConflictException("plan-changed"));
    await expect(t.svc.create(actor, input())).rejects.toBeInstanceOf(ConflictException);
    expect(t.prisma.migrationCampaign.create).not.toHaveBeenCalled();
  });
});

describe("MigrationCampaignsService.startFirstRun and the start flag", () => {
  it("starts the run of the earliest planned wave, as the creator, through the run facade", async () => {
    const t = build();
    const v = await t.svc.create(actor, input({ label: "wave-one", dryRun: true }));
    (t.runs as unknown as { start: jest.Mock }).start = jest.fn(async () => ({}));
    await t.svc.startFirstRun(actor, v);
    const first = v.plan.reduce((best, p, i) => (p.wave < v.plan[best].wave ? i : best), 0);
    expect((t.runs as unknown as { start: jest.Mock }).start).toHaveBeenCalledWith(actor, v.runIds[first], {});
  });
  it("the create body takes an optional start flag and nothing else new", () => {
    expect(input({ start: false }).start).toBe(false);
    expect(input().start).toBeUndefined();
    expect(() => input({ start: "yes" })).toThrow();
  });
});

describe("MigrationCampaignsService across teams", () => {
  /** `a` is taken over in place (server srv-a, team t1), `b` moves to new1 (team t2), `c` to new2 (team t3). */
  const three = () => ({
    hosts: [host("a"), host("b"), host("c")],
    extra: ["new1", "new2"],
    teams: { "srv-a": "t1", new1: "t2", new2: "t3" } as Record<string, string>,
  });
  const multi = (over: Record<string, unknown> = {}) =>
    input({
      confirm: 3,
      placements: [
        { sourceServerRef: "a", kind: "in-place" },
        { sourceServerRef: "b", kind: "other-server", targetServerId: "new1" },
        { sourceServerRef: "c", kind: "other-server", targetServerId: "new2" },
      ],
      ...over,
    });

  it("makes one campaign per team with the same label, the first one on top and all of them listed", async () => {
    const t = build(three());
    const v = await t.svc.create(actor, multi({ label: "move-1" }));
    expect(t.rows.map((r) => [r.teamId, r.label])).toEqual([
      ["t1", "move-1"],
      ["t2", "move-1"],
      ["t3", "move-1"],
    ]);
    expect(v.campaigns).toHaveLength(3);
    expect(v.campaigns.map((c) => c.teamId)).toEqual(["t1", "t2", "t3"]);
    expect(v.id).toBe(v.campaigns[0].id);
    expect(v.runIds).toEqual(v.campaigns[0].runIds);
    expect(v.campaigns.map((c) => c.runIds)).toEqual([["run1"], ["run2"], ["run3"]]);
    expect(v.campaigns.every((c) => c.label === "move-1")).toBe(true);
    // each run targets a server of its own team
    const bodies = t.runs.create.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(bodies.map((b) => b.targetServerId)).toEqual(["srv-a", "new1", "new2"]);
    expect(bodies.map((b) => b.topology)).toEqual(["swap-proxy", "two-box", "two-box"]);
    expect(bodies.every((b) => b.campaign === "move-1")).toBe(true);
  });
  it("a generated label is shared by every team's campaign", async () => {
    const t = build(three());
    await t.svc.create(actor, multi());
    expect(new Set(t.rows.map((r) => r.label)).size).toBe(1);
    expect(String(t.rows[0].label)).toMatch(/^campaign-/);
  });
  it("owner is required in every team before anything is written (a lesser role in the last team refuses the lot)", async () => {
    const t = build({ ...three(), roles: { t3: Role.ADMIN } });
    await expect(t.svc.create(actor, multi())).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.access.requireRole.mock.calls.map((c) => c[1])).toEqual(["t1", "t2", "t3"]);
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
    expect(t.rows).toHaveLength(0);
    expect(t.runs.create).not.toHaveBeenCalled();
  });
  it("the rows are written in one transaction: a label taken in one team leaves nothing in the others", async () => {
    const t = build({ ...three(), labelTakenIn: "t3" });
    await expect(t.svc.create(actor, multi({ label: "x" }))).rejects.toBeInstanceOf(ConflictException);
    expect(t.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(t.rows).toHaveLength(0);
    expect(t.runs.create).not.toHaveBeenCalled();
  });
  it("a run that fails in a later team aborts the runs of the earlier teams and cancels every campaign", async () => {
    const t = build({ ...three(), createFails: 3 });
    await expect(t.svc.create(actor, multi())).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(t.runs.abort.mock.calls.map((c) => c[1])).toEqual(["run1", "run2"]);
    expect(t.prisma.migrationCampaign.update.mock.calls.map((c) => (c[0] as { where?: { id: string } }).where?.id)).toEqual(["camp1", "camp2", "camp3"]);
    expect(t.audit.log.mock.calls.filter((c) => (c[0] as { action: string }).action === "migration.campaign.cancel")).toHaveLength(3);
  });
  it("audits one creation per campaign with its own team and counts, and no server id", async () => {
    const t = build(three());
    await t.svc.create(actor, multi());
    const creates = t.audit.log.mock.calls.map((c) => c[0] as { action: string; meta: Record<string, unknown> }).filter((c) => c.action === "migration.campaign.create");
    expect(creates.map((c) => c.meta.teamId)).toEqual(["t1", "t2", "t3"]);
    expect(creates.every((c) => c.meta.servers === 1 && c.meta.runs === 1 && c.meta.teams === 3)).toBe(true);
    expect(JSON.stringify(creates)).not.toContain("srv-a");
  });
  it("the confirm count is the total number of servers across teams", async () => {
    const t = build(three());
    await expect(t.svc.create(actor, multi({ confirm: 1 }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(t.svc.create(actor, multi({ confirm: 3 }))).resolves.toBeDefined();
  });
  it("two servers moved to the same team stay one two-box run in one campaign", async () => {
    const t = build({ ...three(), teams: { "srv-a": "t1", new1: "t2", new2: "t2" } });
    const v = await t.svc.create(actor, multi());
    expect(v.campaigns).toHaveLength(2);
    expect(t.runs.create).toHaveBeenCalledTimes(2);
    expect(t.runs.create.mock.calls[1][1]).toMatchObject({ topology: "two-box", scope: { sourceServers: ["b", "c"] }, serverMap: { b: "new1", c: "new2" } });
  });
  it("a single team gives a single campaign and the same shape as before", async () => {
    const t = build();
    const v = await t.svc.create(actor, input());
    expect(v.campaigns).toHaveLength(1);
    expect(v.campaigns[0].id).toBe(v.id);
    expect((t.audit.log.mock.calls[0][0] as { meta: Record<string, unknown> }).meta).not.toHaveProperty("teams");
  });
  it("rebuild choices find the in-place run in whichever team it is", async () => {
    const t = build(three());
    await t.svc.create(actor, multi({ rebuild: ["app:a:one"] }));
    const bodies = t.runs.create.mock.calls.map((c) => c[1] as { options: Record<string, unknown> });
    expect(bodies[0].options.rebuild).toEqual(["app:a:one"]);
    expect(bodies[1].options).not.toHaveProperty("rebuild");
  });
  it("a run carries only the service choices of its own servers when the campaign spans teams, and all of them with one team", async () => {
    const choices = { "service:a:s1": { skip: true }, "service:b:s2": { skip: true } };
    const t = build(three());
    await t.svc.create(actor, multi({ serviceChoices: choices }));
    const bodies = t.runs.create.mock.calls.map((c) => c[1] as { serviceChoices?: Record<string, unknown> });
    expect(Object.keys(bodies[0].serviceChoices ?? {})).toEqual(["service:a:s1"]);
    expect(Object.keys(bodies[1].serviceChoices ?? {})).toEqual(["service:b:s2"]);
    expect(bodies[2]).not.toHaveProperty("serviceChoices");
    const one = build();
    await one.svc.create(actor, input({ serviceChoices: choices }));
    expect(Object.keys((one.runs.create.mock.calls[0][1] as { serviceChoices: Record<string, unknown> }).serviceChoices)).toEqual(["service:a:s1", "service:b:s2"]);
  });
  it("one environment cannot stand for the servers of several teams", async () => {
    const t = build(three());
    await expect(t.svc.create(actor, multi({ environmentId: "env1" }))).rejects.toMatchObject({ response: { code: "environment-single-team-only" } });
    expect(t.rows).toHaveLength(0);
  });
  it("preview accepts servers of several teams and returns the runs per team", async () => {
    const t = build(three());
    const r = await t.svc.preview("u1", CampaignPlanSchema.parse({ sessionId: "s1", planHash: HASH, placements: multi().placements }));
    expect(r.failure).toBeNull();
    expect(r.teams?.map((x) => [x.teamId, x.servers, x.runs.length])).toEqual([
      ["t1", 1, 1],
      ["t2", 1, 1],
      ["t3", 1, 1],
    ]);
    expect(r.runs).toHaveLength(3);
    expect(t.prisma.migrationCampaign.create).not.toHaveBeenCalled();
  });
});

describe("MigrationCampaignsService.preview and views", () => {
  it("returns the runs a valid placement becomes and the views, and writes nothing", async () => {
    const t = build();
    const r = await t.svc.preview("u1", CampaignPlanSchema.parse({ sessionId: "s1", planHash: HASH, placements: [{ sourceServerRef: "a", kind: "in-place" }] }));
    expect(r.failure).toBeNull();
    expect(r.runs).toEqual([{ sourceServerRef: "a", kind: "in-place", targetServerId: "srv-a", topology: "swap-proxy", wave: 0 }]);
    expect(r.views.map((v) => v.suggested)).toEqual(["in-place", "in-place"]);
    expect(t.prisma.migrationCampaign.create).not.toHaveBeenCalled();
  });
  it("shows the rebuild choice on the in-place run it belongs to, and a refusal for one that belongs nowhere", async () => {
    const t = build();
    const ok = await t.svc.preview("u1", CampaignPlanSchema.parse({ sessionId: "s1", planHash: HASH, placements: [{ sourceServerRef: "a", kind: "in-place" }, { sourceServerRef: "b", kind: "other-server", targetServerId: "new1" }], rebuild: ["app:a:one"] }));
    expect(ok.runs?.map((r) => r.rebuild)).toEqual([undefined, ["app:a:one"]]);
    const bad = await t.svc.preview("u1", CampaignPlanSchema.parse({ sessionId: "s1", planHash: HASH, placements: [{ sourceServerRef: "a", kind: "in-place" }], rebuild: ["app:b:three"] }));
    expect(bad.runs).toBeNull();
    expect(bad.failure).toEqual({ code: "placement_rebuild_not_in_place", ref: "app:b:three" });
    expect(t.prisma.migrationCampaign.create).not.toHaveBeenCalled();
  });
  it("the placement rows are read with the data modes the plan was reviewed with (its hash depends on them)", async () => {
    const t = build();
    await t.svc.views("u1", { sessionId: "s1", planHash: HASH, dbDataModes: { "database:b:pg": "volume" } });
    expect(t.facts.read.mock.calls[0][1]).toMatchObject({ dbDataModes: { "database:b:pg": "volume" } });
    // the route takes them as a JSON string of the query and checks them like the body's
    expect(CampaignViewsQuerySchema.parse({ sessionId: "s1", planHash: HASH, dbDataModes: JSON.stringify({ "database:b:pg": "volume" }) }).dbDataModes).toEqual({ "database:b:pg": "volume" });
    expect(CampaignViewsQuerySchema.safeParse({ sessionId: "s1", planHash: HASH, dbDataModes: JSON.stringify({ x: "bind" }) }).success).toBe(false);
    expect(CampaignViewsQuerySchema.safeParse({ sessionId: "s1", planHash: HASH, dbDataModes: "{" }).success).toBe(false);
    expect(CampaignViewsQuerySchema.parse({ sessionId: "s1", planHash: HASH }).dbDataModes).toBeUndefined();
  });
  it("reports the failure code instead of throwing", async () => {
    const t = build({ hosts: [host("a", { matchStatus: "ambiguous", matchedServerId: null, agentOnline: false })] });
    const r = await t.svc.preview("u1", CampaignPlanSchema.parse({ sessionId: "s1", planHash: HASH, placements: [{ sourceServerRef: "a", kind: "in-place" }] }));
    expect(r.runs).toBeNull();
    expect(r.failure).toEqual({ code: "placement_in_place_locked", ref: "a", reason: "match_uncertain" });
  });
});

describe("MigrationCampaignsService.get, list and cancel", () => {
  it("another team's campaign reads as unknown", async () => {
    const t = build({ role: null });
    t.rows.push({ id: "camp1", teamId: "t9", label: "l", sessionId: null, status: "draft", plan: [], createdAt: new Date() });
    await expect(t.svc.get("u1", "camp1")).rejects.toBeInstanceOf(NotFoundException);
  });
  it("cancel aborts only runs that have not started and audits the count", async () => {
    const t = build();
    t.rows.push({ id: "camp1", teamId: "t1", label: "l", sessionId: null, status: "draft", plan: [], createdAt: new Date() });
    t.prisma.migrationRun.findMany.mockResolvedValueOnce([{ id: "r1", status: "QUEUED" }, { id: "r2", status: "RUNNING" }]);
    const v = await t.svc.cancel(actor, "camp1");
    expect(t.runs.abort).toHaveBeenCalledTimes(1);
    expect(t.runs.abort).toHaveBeenCalledWith(actor, "r1", { confirmName: "r1" });
    expect(v.status).toBe("cancelled");
    expect((t.audit.log.mock.calls[0][0] as { meta: Record<string, number> }).meta.aborted).toBe(1);
  });
  it("only the owner may cancel", async () => {
    const t = build({ role: Role.ADMIN });
    t.rows.push({ id: "camp1", teamId: "t1", label: "l", sessionId: null, status: "draft", plan: [], createdAt: new Date() });
    await expect(t.svc.cancel(actor, "camp1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.runs.abort).not.toHaveBeenCalled();
  });
});

describe("runBody and the DTOs", () => {
  it("a run spanning several targets carries a server map; a single one does not", () => {
    const placements = [
      { sourceServerRef: "a", kind: "other-server" as const, targetServerId: "n1" },
      { sourceServerRef: "b", kind: "other-server" as const, targetServerId: "n2" },
    ];
    const run = { sourceServerRef: "a", sourceServerRefs: ["a", "b"], kind: "other-server" as const, targetServerId: "n1", topology: "two-box" as const, wave: 0 };
    expect(runBody(input(), run, placements, "l")).toMatchObject({ serverMap: { a: "n1", b: "n2" }, scope: { sourceServers: ["a", "b"] } });
    expect(runBody(input(), { ...run, sourceServerRefs: undefined }, placements.slice(0, 1), "l")).not.toHaveProperty("serverMap");
  });
  it("a run body carries the run's own rebuild list in its options and leaves the campaign's options alone", () => {
    const run = { sourceServerRef: "a", kind: "in-place" as const, targetServerId: "srv-a", topology: "swap-proxy" as const, wave: 0, rebuild: ["app:a:one"] };
    const shared = input();
    const body = runBody(shared, run, [{ sourceServerRef: "a", kind: "in-place", targetServerId: "srv-a" }], "l");
    expect(body.options.rebuild).toEqual(["app:a:one"]);
    expect(shared.options).not.toHaveProperty("rebuild");
    expect(runBody(shared, { ...run, rebuild: undefined }, [], "l").options).not.toHaveProperty("rebuild");
  });
  it("the rebuild list refuses a service, an empty or spaced ref, a non-array and more than 500", () => {
    const base = { sessionId: "s", planHash: HASH, placements: [{ sourceServerRef: "a", kind: "in-place" }] };
    expect(CampaignPlanSchema.parse({ ...base, rebuild: ["app:a:x"] }).rebuild).toEqual(["app:a:x"]);
    expect(CampaignPlanSchema.parse(base)).not.toHaveProperty("rebuild");
    for (const bad of [["service:a:x"], [""], ["app:a: x"], "app:a:x", Array.from({ length: 501 }, (_, i) => `app:a:${i}`)]) expect(() => CampaignPlanSchema.parse({ ...base, rebuild: bad })).toThrow();
  });
  it("the DTO refuses an unknown field, a reserved ref and an unknown kind", () => {
    expect(() => CampaignPlanSchema.parse({ sessionId: "s", planHash: HASH, placements: [{ sourceServerRef: "a", kind: "in-place" }], mapping: {} })).toThrow();
    expect(() => CampaignPlanSchema.parse({ sessionId: "s", planHash: HASH, placements: [{ sourceServerRef: "__proto__", kind: "in-place" }] })).toThrow();
    expect(() => CampaignPlanSchema.parse({ sessionId: "s", planHash: HASH, placements: [{ sourceServerRef: "a", kind: "sideways" }] })).toThrow();
    expect(() => CampaignPlanSchema.parse({ sessionId: "s", planHash: HASH, placements: [] })).toThrow();
  });
});

describe("MigrationCampaignsService: data modes, scope, shared targets and takeover checks", () => {
  const plan = (over: Record<string, unknown> = {}) => CampaignPlanSchema.parse({ sessionId: "s1", planHash: HASH, placements: [{ sourceServerRef: "a", kind: "in-place" }, { sourceServerRef: "b", kind: "other-server", targetServerId: "new1" }], ...over });
  const ITEMS = [
    { itemRef: "app:a:one", kind: "app", name: "one" },
    { itemRef: "app:a:two", kind: "app", name: "two" },
    { itemRef: "app:b:three", kind: "app", name: "three" },
    { itemRef: "database:b:pg", kind: "database", name: "pg" },
  ];

  it("reads the plan back with the data modes the owner reviewed, for the preview and for the create", async () => {
    const t = build();
    await t.svc.preview("u1", plan({ dbDataModes: { "database:b:pg": "volume" } }));
    expect(t.facts.read.mock.calls[0][1]).toMatchObject({ dbDataModes: { "database:b:pg": "volume" } });
    await t.svc.create(actor, input({ dbDataModes: { "database:b:pg": "volume" } }));
    expect(t.facts.read.mock.calls[1][1]).toMatchObject({ dbDataModes: { "database:b:pg": "volume" } });
  });

  it("a campaign keeps to the first step's selection: a run carries only the items of its servers that were picked", async () => {
    const t = build({ items: ITEMS });
    // everything of `a` is picked and `b`'s pg only: the copied run leaves its app out
    await t.svc.create(actor, input({ scope: { include: ["app:a:one", "app:a:two", "database:b:pg"] } }));
    const bodies = t.runs.create.mock.calls.map((c) => c[1] as { scope: Record<string, unknown> });
    expect(bodies[0].scope).toEqual({ sourceServers: ["b"], exclude: ["app:b:three"] });
    expect(bodies[1].scope).toEqual({ sourceServers: ["a"] });
  });

  it("a same-machine server with only part of it picked is refused: the proxy swap takes the whole machine", async () => {
    const t = build({ items: ITEMS });
    await expect(t.svc.create(actor, input({ scope: { include: ["app:a:one", "app:b:three"] } }))).rejects.toMatchObject({ response: { code: "placement_in_place_partial", ref: "a" } });
    expect(t.prisma.migrationCampaign.create).not.toHaveBeenCalled();
    expect(t.runs.create).not.toHaveBeenCalled();
    const p = await t.svc.preview("u1", plan({ scope: { include: ["app:a:one", "app:b:three"] } }));
    expect(p.failure).toEqual({ code: "placement_in_place_partial", ref: "a" });
  });

  it("a placed server with nothing picked, or a selection the plan does not know, is refused before anything is written", async () => {
    const t = build({ items: ITEMS });
    await expect(t.svc.create(actor, input({ scope: { include: ["app:b:three"] } }))).rejects.toMatchObject({ response: { code: "placement_scope_empty", ref: "a" } });
    await expect(t.svc.create(actor, input({ scope: { include: ["app:z:ghost"] } }))).rejects.toMatchObject({ response: { code: "placement_scope_invalid" } });
    expect(t.runs.create).not.toHaveBeenCalled();
  });

  it("without a selection every run keeps the whole servers it carries (as before)", async () => {
    const t = build({ items: ITEMS });
    await t.svc.create(actor, input());
    const bodies = t.runs.create.mock.calls.map((c) => c[1] as { scope: Record<string, unknown> });
    expect(bodies.map((b) => b.scope)).toEqual([{ sourceServers: ["b"] }, { sourceServers: ["a"] }]);
  });

  it("two source servers on one Tugra machine are refused at the placement, naming both, not at the second run create", async () => {
    const t = build({ hosts: [host("a", { matchedServerId: "srv-x" }), host("b", { matchedServerId: "srv-x" })], extra: ["srv-x"] });
    const p = await t.svc.preview("u1", plan({ placements: [{ sourceServerRef: "a", kind: "in-place" }, { sourceServerRef: "b", kind: "in-place" }] }));
    expect(p.failure).toEqual({ code: "placement_target_shared", ref: "b", withRef: "a" });
    await expect(t.svc.create(actor, input({ placements: [{ sourceServerRef: "a", kind: "in-place" }, { sourceServerRef: "b", kind: "in-place" }] }))).rejects.toMatchObject({ response: { code: "placement_target_shared", ref: "b", withRef: "a" } });
    expect(t.prisma.migrationCampaign.create).not.toHaveBeenCalled();
  });

  it("a takeover that would be refused at its start is refused at the placement: another holder, or Tugra's proxy already serving apps", async () => {
    const busy = build({ items: ITEMS, startRefusal: { "srv-a": "takeover_server_busy" } });
    expect((await busy.svc.preview("u1", plan())).failure).toEqual({ code: "placement_takeover_busy", ref: "a" });
    await expect(busy.svc.create(actor, input())).rejects.toMatchObject({ response: { code: "placement_takeover_busy", ref: "a" } });
    expect(busy.runs.create).not.toHaveBeenCalled();
    expect(busy.prisma.migrationCampaign.create).not.toHaveBeenCalled();
    const proxy = build({ items: ITEMS, startRefusal: { "srv-a": "takeover_tugra_proxy_in_use" } });
    expect((await proxy.svc.preview("u1", plan())).failure).toEqual({ code: "placement_tugra_proxy_in_use", ref: "a" });
    // a server that is copied to is not taken over: nothing to ask
    expect(proxy.inplace.startRefusal).toHaveBeenCalledTimes(1);
  });

  it("cancel leaves a finished dry run alone (it has nothing to abort) and says how many dry runs it blocked", async () => {
    const t = build();
    t.rows.push({ id: "camp1", teamId: "t1", label: "l", sessionId: null, status: "draft", plan: [], createdAt: new Date() });
    t.prisma.migrationRun.findMany.mockResolvedValueOnce([{ id: "r1", status: "DRY_RUN_DONE" }, { id: "r2", status: "QUEUED" }]);
    const v = await t.svc.cancel(actor, "camp1");
    expect(t.runs.abort).toHaveBeenCalledTimes(1);
    expect(t.runs.abort).toHaveBeenCalledWith(actor, "r2", { confirmName: "r2" });
    expect(v.status).toBe("cancelled");
    expect((t.audit.log.mock.calls[0][0] as { meta: Record<string, number> }).meta).toMatchObject({ aborted: 1, dryRuns: 1 });
  });
});

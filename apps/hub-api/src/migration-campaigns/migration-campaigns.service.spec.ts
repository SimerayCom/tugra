import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { MigrationCampaignsService, runBody } from "./migration-campaigns.service";
import { CampaignCreateSchema, CampaignPlanSchema } from "./dto";
import type { CampaignFacts } from "./campaign-facts.service";
import type { PlacementHostFact } from "./campaign-plan";
import type { RunActor } from "../migration-runs/core/run-contract";

const actor: RunActor = { userId: "u1", scopes: ["*"], channel: "session" } as RunActor;
const HASH = "a".repeat(32);

const host = (ref: string, o: Partial<PlacementHostFact> = {}): PlacementHostFact => ({ ref, name: ref, controlPlane: false, matchStatus: "certain", linkedBy: "auto", evidence: [], matchedServerId: `srv-${ref}`, agentOnline: true, ...o });
function factsOf(hosts: PlacementHostFact[], extra: string[] = ["new1"]): CampaignFacts {
  const targets = new Map<string, { id: string; teamId: string; ready: boolean }>();
  for (const h of hosts) if (h.matchedServerId) targets.set(h.matchedServerId, { id: h.matchedServerId, teamId: "t1", ready: true });
  for (const e of extra) targets.set(e, { id: e, teamId: "t1", ready: true });
  return { planHash: HASH, hosts, targets };
}

function build(o: { hosts?: PlacementHostFact[]; role?: Role | null; createFails?: number; labelTaken?: boolean } = {}) {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    migrationCampaign: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (o.labelTaken) throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
        const r = { id: "camp1", createdAt: new Date("2026-11-26T10:00:00Z"), ...data };
        rows.push(r);
        return r;
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...rows[0], ...data })),
      findUnique: jest.fn(async () => rows[0] ?? null),
      findMany: jest.fn(async () => rows),
    },
    migrationRun: { findMany: jest.fn(async () => [{ id: "run1", status: "QUEUED" }, { id: "run2", status: "QUEUED" }]) },
  };
  const access = {
    requireRole: jest.fn(async (..._a: unknown[]) => {
      if (o.role === undefined || o.role === Role.OWNER) return;
      throw new ForbiddenException("insufficient role for this team");
    }),
    teamRole: jest.fn(async () => (o.role === undefined ? Role.OWNER : o.role)),
  };
  const audit = { log: jest.fn(async (..._a: unknown[]) => undefined) };
  const facts = { read: jest.fn(async (..._a: unknown[]) => factsOf(o.hosts ?? [host("a"), host("b")])) };
  let n = 0;
  const runs = {
    create: jest.fn(async (..._a: unknown[]) => {
      n += 1;
      if (o.createFails && n === o.createFails) throw new UnprocessableEntityException("target-offline");
      return { id: `run${n}` };
    }),
    abort: jest.fn(async (..._a: unknown[]) => ({})),
  };
  const svc = new MigrationCampaignsService(prisma as never, access as never, audit as never, facts as never, runs as never);
  return { svc, prisma, access, audit, facts, runs, rows };
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

describe("MigrationCampaignsService.preview and views", () => {
  it("returns the runs a valid placement becomes and the views, and writes nothing", async () => {
    const t = build();
    const r = await t.svc.preview("u1", CampaignPlanSchema.parse({ sessionId: "s1", planHash: HASH, placements: [{ sourceServerRef: "a", kind: "in-place" }] }));
    expect(r.failure).toBeNull();
    expect(r.runs).toEqual([{ sourceServerRef: "a", kind: "in-place", targetServerId: "srv-a", topology: "swap-proxy", wave: 0 }]);
    expect(r.views.map((v) => v.suggested)).toEqual(["in-place", "in-place"]);
    expect(t.prisma.migrationCampaign.create).not.toHaveBeenCalled();
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
  it("the DTO refuses an unknown field, a reserved ref and an unknown kind", () => {
    expect(() => CampaignPlanSchema.parse({ sessionId: "s", planHash: HASH, placements: [{ sourceServerRef: "a", kind: "in-place" }], mapping: {} })).toThrow();
    expect(() => CampaignPlanSchema.parse({ sessionId: "s", planHash: HASH, placements: [{ sourceServerRef: "__proto__", kind: "in-place" }] })).toThrow();
    expect(() => CampaignPlanSchema.parse({ sessionId: "s", planHash: HASH, placements: [{ sourceServerRef: "a", kind: "sideways" }] })).toThrow();
    expect(() => CampaignPlanSchema.parse({ sessionId: "s", planHash: HASH, placements: [] })).toThrow();
  });
});

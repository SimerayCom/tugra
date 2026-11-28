import { ConflictException, ForbiddenException, Logger, NotFoundException } from "@nestjs/common";
import { Role } from "@prisma/client";
import type { CampaignRunPlan } from "@tugra/shared";
import { CampaignAdvancerService } from "./campaign-advancer.service";
import type { RunActor } from "../migration-runs/core/run-contract";

const actor: RunActor = { userId: "u1", scopes: ["*"], channel: "session" } as RunActor;
const plan: CampaignRunPlan[] = [
  { sourceServerRef: "a", kind: "in-place", targetServerId: "s1", topology: "swap-proxy", wave: 0 },
  { sourceServerRef: "b", kind: "in-place", targetServerId: "s2", topology: "swap-proxy", wave: 1 },
];

interface RunRow { id: string; status: string; targetServerId: string; inPlace: boolean; dryRun: boolean; createdAt: Date; steps: Array<{ key: string; status: string }> }
const runRow = (id: string, target: string, over: Partial<RunRow> = {}): RunRow => ({ id, status: "QUEUED", targetServerId: target, inPlace: true, dryRun: false, createdAt: new Date("2026-11-28T08:00:00Z"), steps: [], ...over });

function build(o: { campaign?: Record<string, unknown>; runs?: RunRow[]; role?: Role | null; startFails?: string[] } = {}) {
  const campaign: Record<string, unknown> = { id: "c1", teamId: "t1", actorId: "u1", label: "move-1", status: "draft", driving: false, plan, createdAt: new Date("2026-11-28T08:00:00Z"), ...o.campaign };
  const prisma = {
    migrationCampaign: {
      findUnique: jest.fn(async () => campaign),
      findMany: jest.fn(async () => (campaign.driving && campaign.status !== "cancelled" ? [{ id: "c1" }] : [])),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(campaign, data)),
    },
    migrationRun: { findMany: jest.fn(async () => o.runs ?? []) },
  };
  const access = { teamRole: jest.fn(async () => (o.role === undefined ? Role.OWNER : o.role)) };
  const audit = { log: jest.fn(async () => undefined) };
  const campaigns = { get: jest.fn(async () => ({ id: "c1", driving: campaign.driving })) };
  const runs = {
    start: jest.fn(async (_a: unknown, id: string) => {
      if (o.startFails?.includes(id)) throw new ConflictException("run-not-startable");
      return { id };
    }),
  };
  const svc = new CampaignAdvancerService(prisma as never, access as never, audit as never, campaigns as never, runs as never);
  return { svc, prisma, access, audit, campaigns, runs, campaign };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
});

describe("CampaignAdvancerService", () => {
  it("Start all hands the campaign to the hub and starts the first wave at once, through the run facade as the creator", async () => {
    const t = build({ runs: [runRow("r1", "s1"), runRow("r2", "s2")] });
    await t.svc.start(actor, "c1");
    expect(t.campaign.driving).toBe(true);
    expect(t.runs.start).toHaveBeenCalledTimes(1);
    expect(t.runs.start).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), "r1", {});
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "migration.campaign.start", target: "c1" }));
  });

  it("the next tick starts the next wave once the first waits for the owner's approval, without anybody coming back", async () => {
    const t = build({ campaign: { driving: true }, runs: [runRow("r1", "s1", { status: "WAITING", steps: [{ key: "VERIFY", status: "WAITING_APPROVAL" }] }), runRow("r2", "s2")] });
    expect(await t.svc.tick()).toEqual(["r2"]);
  });

  it("does nothing for a campaign that was not handed over, or was cancelled", async () => {
    const idle = build({ runs: [runRow("r1", "s1"), runRow("r2", "s2")] });
    expect(await idle.svc.tick()).toEqual([]);
    expect(idle.runs.start).not.toHaveBeenCalled();
    const cancelled = build({ campaign: { driving: true, status: "cancelled" }, runs: [runRow("r1", "s1")] });
    expect(await cancelled.svc.tick()).toEqual([]);
    await expect(cancelled.svc.start(actor, "c1")).rejects.toThrow(/campaign-cancelled/);
  });

  it("does not start anything behind a failed run, and does not drop the campaign: it goes on when the owner fixes the run", async () => {
    const t = build({ campaign: { driving: true }, runs: [runRow("r1", "s1", { status: "FAILED" }), runRow("r2", "s2")] });
    const d = await t.svc.advance("c1");
    expect(d.started).toEqual([]);
    expect(d.decision?.hold?.code).toBe("run-failed");
    expect(t.campaign.driving).toBe(true);
  });

  it("lets the campaign go once every run completed", async () => {
    const t = build({ campaign: { driving: true }, runs: [runRow("r1", "s1", { status: "COMPLETED" }), runRow("r2", "s2", { status: "COMPLETED" })] });
    await t.svc.advance("c1");
    expect(t.campaign.driving).toBe(false);
  });

  it("lets the campaign go when its creator is no longer an owner of the team", async () => {
    const t = build({ campaign: { driving: true }, role: Role.VIEWER, runs: [runRow("r1", "s1")] });
    expect((await t.svc.advance("c1")).started).toEqual([]);
    expect(t.campaign.driving).toBe(false);
    expect(t.runs.start).not.toHaveBeenCalled();
  });

  it("a run that cannot be started (the owner just started it) is left for the next pass and does not stop the tick", async () => {
    const t = build({ campaign: { driving: true }, runs: [runRow("r1", "s1")], startFails: ["r1"] });
    expect(await t.svc.tick()).toEqual([]);
  });

  it("pause stops starting new servers and starts nothing itself", async () => {
    const t = build({ campaign: { driving: true }, runs: [runRow("r1", "s1")] });
    await t.svc.pause(actor, "c1");
    expect(t.campaign.driving).toBe(false);
    expect(await t.svc.tick()).toEqual([]);
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "migration.campaign.pause" }));
  });

  it("only the creator who is still an owner can hand it over or pause it; a stranger sees no campaign", async () => {
    await expect(build({ role: Role.ADMIN }).svc.start(actor, "c1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(build({ campaign: { actorId: "u2" } }).svc.start(actor, "c1")).rejects.toThrow(/campaign-creator-only/);
    await expect(build({ role: null }).svc.pause(actor, "c1")).rejects.toBeInstanceOf(NotFoundException);
  });
});

import { MigrationCampaignsController } from "./migration-campaigns.controller";
import type { CampaignView } from "@tugra/shared";
import type { AuthUser } from "../auth/strategies/jwt.strategy";

const user = { userId: "u1", scopes: ["*"], channel: "session" } as unknown as AuthUser;
const view = (id: string, over: Partial<CampaignView> = {}): CampaignView => ({
  id,
  teamId: "t1",
  label: "move",
  sessionId: "s1",
  status: "draft",
  plan: [{ sourceServerRef: "a", kind: "in-place", targetServerId: "s1", topology: "swap-proxy", wave: 0 }],
  runIds: ["r1"],
  driving: false,
  createdAt: "2026-11-28T08:00:00.000Z",
  ...over,
});

function build(created: CampaignView[]) {
  const campaigns = { create: jest.fn(async () => ({ ...created[0], campaigns: created })), startFirstRun: jest.fn(async () => undefined) };
  const advancer = { start: jest.fn(async (_a: unknown, id: string) => view(id, { driving: true, status: "running" })) };
  const ctrl = new MigrationCampaignsController(campaigns as never, advancer as never, {} as never);
  return { ctrl, campaigns, advancer };
}

describe("MigrationCampaignsController.create: creating and starting are one request", () => {
  it("hands every campaign it made to the hub and answers with them driving", async () => {
    const t = build([view("c1"), view("c2", { teamId: "t2" })]);
    const res = await t.ctrl.create(user, { dryRun: false } as never);
    expect(t.advancer.start).toHaveBeenCalledTimes(2);
    expect(res.campaigns.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(res.campaigns.every((c) => c.driving === true)).toBe(true);
    expect(res.id).toBe("c1");
  });
  it("start:false leaves the runs queued for 'Start all'", async () => {
    const t = build([view("c1")]);
    const res = await t.ctrl.create(user, { start: false } as never);
    expect(t.advancer.start).not.toHaveBeenCalled();
    expect(res.driving).toBe(false);
  });
  it("a dry run is started once, not driven", async () => {
    const t = build([view("c1")]);
    await t.ctrl.create(user, { dryRun: true } as never);
    expect(t.advancer.start).not.toHaveBeenCalled();
    expect(t.campaigns.startFirstRun).toHaveBeenCalledTimes(1);
  });
  it("a campaign that cannot be handed over stays as made and does not fail the create", async () => {
    const t = build([view("c1")]);
    t.advancer.start.mockRejectedValueOnce(new Error("boom"));
    const res = await t.ctrl.create(user, { dryRun: false } as never);
    expect(res.id).toBe("c1");
    expect(res.driving).toBe(false);
  });
});

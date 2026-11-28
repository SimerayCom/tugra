import { Logger } from "@nestjs/common";
import { ACTOR, RunWorld } from "./testing/run-world";
import type { ApprovalBinding } from "./dto";

jest.setTimeout(30_000);

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

const binding = (): ApprovalBinding => ({ inputHash: "a".repeat(64), ponr: false, confirm: "run-id", ttlSec: null, requiresDataRisk: false, ackable: [], requiredAcks: [], review: {} });

describe("one swap at a time inside a campaign", () => {
  /** An in-place run of campaign c1 waiting for its VERIFY approval, and a second in-place run of the same campaign made by hand. */
  async function setup(campaign: string | null = "c1") {
    const w = new RunWorld({ stubs: { VERIFY: { binding } } });
    const body = w.createBody({ topology: "swap-proxy", mode: "takeover", ...(campaign ? { campaign } : {}) });
    const a = (await w.service.create(ACTOR, body, { inPlace: true })).id;
    await w.start(a);
    await w.settle(a);
    const other = (await w.service.create(ACTOR, { ...body, dryRun: true }, { inPlace: true })).id;
    return { w, a, other };
  }
  const approve = (w: RunWorld, id: string) => w.service.approve(ACTOR, id, "VERIFY", { boundHash: "a".repeat(64), acks: [], confirmName: id });

  it("refuses the approval while another run of the campaign has its swap running", async () => {
    const { w, a, other } = await setup();
    expect(w.stepStatus(a, "VERIFY")).toBe("WAITING_APPROVAL");
    await w.store.updateRun(other, {}, { status: "RUNNING" });
    await w.store.updateStep(other, "VERIFY", { status: "PASSED" });
    await w.store.updateStep(other, "CUTOVER", { status: "RUNNING" });
    await expect(approve(w, a)).rejects.toMatchObject({ response: { message: "campaign-swap-busy" } });
    expect(w.store.step(a, "VERIFY").approval).toBeNull();
  });

  it("refuses it while the other run is approved but its swap has not begun", async () => {
    const { w, a, other } = await setup();
    await w.store.updateRun(other, {}, { status: "WAITING" });
    await w.store.updateStep(other, "VERIFY", { status: "WAITING_APPROVAL", approval: { at: "2026-11-28T08:00:00.000Z" } });
    await expect(approve(w, a)).rejects.toMatchObject({ response: { message: "campaign-swap-busy" } });
  });

  it("allows it once the other run has switched, and when the other run only waits for its own approval", async () => {
    const { w, a, other } = await setup();
    await w.store.updateRun(other, {}, { status: "WAITING" });
    await w.store.updateStep(other, "VERIFY", { status: "WAITING_APPROVAL" });
    await approve(w, a);
    expect(w.store.step(a, "VERIFY").approval).not.toBeNull();
    const second = await setup();
    await second.w.store.updateRun(second.other, {}, { status: "RUNNING" });
    await second.w.store.updateStep(second.other, "VERIFY", { status: "PASSED" });
    await second.w.store.updateStep(second.other, "CUTOVER", { status: "PASSED" });
    await approve(second.w, second.a);
  });

  it("a run outside any campaign is never held by another run", async () => {
    const { w, a } = await setup(null);
    await approve(w, a);
    expect(w.store.step(a, "VERIFY").approval).not.toBeNull();
  });
});

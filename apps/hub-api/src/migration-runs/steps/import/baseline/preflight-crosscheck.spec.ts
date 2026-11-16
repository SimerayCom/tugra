import { Logger } from "@nestjs/common";
import { StepHandlerRegistryService } from "../../../core/step-handler.registry";
import { H32, defaultPlan } from "../../../core/testing/run-world";
import { INVENTORY_CODES } from "../../data/inventory/cross-check";
import { emptyHostView, type HostView } from "../../data/inventory/host-view";
import type { HostInventory } from "../../data/inventory/host-protocol";
import { FakeHostReports } from "../../data/inventory/testing/fake-host-reports";
import { answered, makeCtx, makeRun } from "../../data/testing/fakes";
import type { ImportStepsPort } from "../import-ports";
import { PreflightStep, preflightChecks, type PreflightObs } from "../preflight.step";
import { preflightCrossCheck } from "./preflight-crosscheck";

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
});

const GHOST = "dbghostgggggggggggggggggg";
const LISTED = "dblistedllllllllllllllll";
const id = (c: string) => c.repeat(64);

const plan = defaultPlan({
  items: [
    { itemRef: `database:host-a:${LISTED}`, kind: "database", name: "pg-main", proposed: { engine: "POSTGRES" }, risks: [], dependsOn: [] },
    { itemRef: "app:host-a:appaaaaaaaaaaaaaaaaaaaaa", kind: "app", name: "web", proposed: { domain: "web.example.test" }, risks: [], dependsOn: [] },
  ],
});

const inventory = (over: Partial<HostInventory> = {}): HostInventory => ({
  ref: "host-a",
  host: { name: "host-a", docker: "27", os: "" },
  containers: [
    { id: id("a"), name: LISTED, image: "postgres:16", state: "running" },
    { id: id("b"), name: GHOST, image: "postgres:17", state: "running" },
  ],
  mounts: [],
  volumes: [],
  binds: [],
  complete: true,
  rejected: 0,
  ...over,
});
const viewWith = (inv: HostInventory): HostView => ({ ...emptyHostView(), inventories: new Map([[inv.ref, inv]]) });

describe("preflightCrossCheck: the docker-vs-API cross-check at PREFLIGHT, for early visibility (R2/C6)", () => {
  it("an unlisted database container is a WARNING here (never a block) and carries no attestation: DATA_SEED stays the gate that blocks", () => {
    const checks = preflightCrossCheck(makeRun(), plan, viewWith(inventory()));
    const finding = checks.find((c) => c.code === INVENTORY_CODES.unlistedDb)!;
    expect(finding).toMatchObject({ status: "warn", subject: `host-a/${GHOST}`, evidence: "host-loop-reported", params: expect.objectContaining({ container: GHOST, engine: expect.any(String) }) });
    expect(finding.attestable).toBeUndefined();
    expect(finding.id.startsWith("preflight.")).toBe(true);
    expect(finding.id.length).toBeLessThanOrEqual(80);
    expect(checks.every((c) => c.status !== "fail" && c.status !== "unknown")).toBe(true);
  });

  it("the plan's own database is not a finding, and a run with no inventory yet says nothing", () => {
    const only = preflightCrossCheck(makeRun(), plan, viewWith(inventory({ containers: [{ id: id("a"), name: LISTED, image: "postgres:16", state: "running" }] })));
    expect(only).toEqual([]);
    expect(preflightCrossCheck(makeRun(), plan, emptyHostView())).toEqual([]);
    expect(preflightCrossCheck(makeRun(), plan, undefined)).toEqual([]);
  });

  it("a truncated inventory (it cannot prove the ABSENCE of an unlisted database) is a warning too, not a block", () => {
    const checks = preflightCrossCheck(makeRun(), plan, viewWith(inventory({ complete: false })));
    expect(checks).toContainEqual(expect.objectContaining({ code: INVENTORY_CODES.truncated, status: "warn" }));
  });

  it("the owner's policy still shows as what it is (skip: a warning naming the skip), and an orphan volume is reported", () => {
    const skip = preflightCrossCheck(makeRun({ inputs: { unlistedDbPolicy: answered("skip" as const) } }), plan, viewWith(inventory()));
    expect(skip).toContainEqual(expect.objectContaining({ code: INVENTORY_CODES.unlistedDbSkipped, status: "warn" }));
    const orphan = preflightCrossCheck(makeRun(), plan, viewWith(inventory({ containers: [], volumes: [{ name: "left-over-data", links: 0, sizeKiB: 100 }] as never })));
    expect(orphan).toContainEqual(expect.objectContaining({ code: INVENTORY_CODES.orphanVolume, status: "warn" }));
  });
});

describe("PREFLIGHT runs the cross-check as part of its gate", () => {
  const run = () => makeRun();
  const obs = (over: Partial<PreflightObs> = {}): PreflightObs => ({
    session: "active",
    plan,
    planError: null,
    target: { serverName: "box", agentOnline: true, capabilities: ["deploy", "database"], acmeEmailOk: true, proxyBind: "public", dnsCredential: false, zones: [] },
    mapping: null,
    storedMappingBlocks: false,
    services: null,
    ...over,
  });

  it("the finding is in the check list (and so in the gate and the dry-run) without making the gate fail", () => {
    const withFinding = preflightChecks({ ...run(), planHash: plan.planHash } as never, obs({ hosts: viewWith(inventory()) }));
    expect(withFinding).toContainEqual(expect.objectContaining({ code: INVENTORY_CODES.unlistedDb, status: "warn" }));
    expect(withFinding.filter((c) => c.status === "fail").map((c) => c.code)).not.toContain(INVENTORY_CODES.unlistedDb);
    const without = preflightChecks({ ...run(), planHash: plan.planHash } as never, obs());
    expect(without.map((c) => c.code)).not.toContain(INVENTORY_CODES.unlistedDb);
  });

  it("observe reads the stored host reports of the run through the host report port", async () => {
    const reports = new FakeHostReports();
    reports.set(run().id, { stepKey: "", sourceServerRef: "host-a", kind: "inventory", state: "complete", payload: inventory() as unknown as Record<string, unknown> });
    const port = {
      sessionState: async () => "active",
      plan: async () => plan,
      target: async () => ({ serverName: "box", agentOnline: true, capabilities: ["deploy", "database"], acmeEmailOk: true, proxyBind: "public", dnsCredential: false, zones: [] }),
    } as unknown as ImportStepsPort;
    const step = new PreflightStep(new StepHandlerRegistryService(), port, undefined, reports);
    const ctx = makeCtx({ key: "PREFLIGHT", run: makeRun({ options: { sourceRunner: "coolify-host-loop" } }) }).ctx;
    const o = await step.observe(ctx);
    expect(o.hosts?.inventories.get("host-a")?.containers.map((c) => c.name)).toContain(GHOST);
    expect(preflightChecks({ ...ctx.run, planHash: H32 } as never, o)).toContainEqual(expect.objectContaining({ code: INVENTORY_CODES.unlistedDb, status: "warn" }));
    // a hub without the report port (a unit module) just has nothing to say
    const bare = new PreflightStep(new StepHandlerRegistryService(), port);
    expect((await bare.observe(ctx)).hosts).toBeUndefined();
    // and a store that fails never fails PREFLIGHT
    reports.list = async () => {
      throw new Error("database unavailable");
    };
    expect((await step.observe(ctx)).hosts?.inventories.size).toBe(0);
  });
});

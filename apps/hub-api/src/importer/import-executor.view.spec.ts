import { toStatusView } from "./import-executor.service";

/** A BulkOperation row (with its tasks) as toStatusView consumes it. */
const op = (over: Partial<Parameters<typeof toStatusView>[0]> = {}) => ({
  id: "op1",
  planId: "a".repeat(32),
  meta: {
    sourceKind: "coolify",
    serverId: "srv1",
    plan: { sourceKind: "coolify", mode: "copy", planHash: "a".repeat(32), warnings: ["w1"], totals: { apps: 1, databases: 0, volumes: 0, blockers: 1 }, items: [{ itemRef: "app:srv:web", kind: "app", name: "web", proposed: { envCount: 3 }, risks: [], dependsOn: [] }] },
  },
  cancelRequestedAt: null,
  createdAt: new Date("2026-10-18T00:00:00.000Z"),
  tasks: [
    { itemRef: "app:srv:web", kind: "app", status: "DONE", resourceType: "application", resourceId: "app1", result: { name: "web", appId: "app1", unresolvedEnv: 2 }, output: null, startedAt: null, finishedAt: null },
    { itemRef: "app:srv:api", kind: "app", status: "FAILED", resourceType: null, resourceId: null, result: { name: "api" }, output: "nothing to deploy", startedAt: null, finishedAt: null },
  ],
  ...over,
});

describe("toStatusView", () => {
  it("surfaces the persisted plan snapshot (the durable record)", () => {
    const v = toStatusView(op());
    expect(v.plan).toMatchObject({ planHash: "a".repeat(32), totals: { apps: 1, blockers: 1 }, warnings: ["w1"] });
    expect((v.plan as { items: unknown[] }).items).toHaveLength(1);
    // the plan is secret-free: envCount (a number), never env values
    expect(JSON.stringify(v.plan)).not.toMatch(/value/i);
  });

  it("is null for a legacy op with no stored plan", () => {
    expect(toStatusView(op({ meta: { sourceKind: "local-docker", serverId: "srv1" } })).plan).toBeNull();
  });

  it("records per-task outcome: status, resource id, error message, unresolved-env count", () => {
    const v = toStatusView(op());
    expect(v.status).toBe("PARTIAL"); // one DONE + one FAILED
    expect(v.totals).toMatchObject({ total: 2, done: 1, failed: 1 });
    const web = v.tasks.find((t) => t.itemRef === "app:srv:web")!;
    expect(web).toMatchObject({ name: "web", status: "DONE", resourceId: "app1", unresolvedEnv: 2 });
    const api = v.tasks.find((t) => t.itemRef === "app:srv:api")!;
    expect(api).toMatchObject({ name: "api", status: "FAILED", message: "nothing to deploy" });
  });
});

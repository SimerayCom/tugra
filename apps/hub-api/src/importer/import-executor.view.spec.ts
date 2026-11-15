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

  it("returns postCreate/ingress per task (names + fixed reasons), undefined when absent, and drops malformed entries", () => {
    const v = toStatusView(
      op({
        tasks: [
          { itemRef: "app:srv:web", kind: "app", status: "DONE", resourceType: "application", resourceId: "app1", result: { name: "web", postCreate: { applied: ["build", 7, "customLabels"], unmapped: [{ field: "customLabel:traefik.enable", reason: "reserved" }, { field: 1 }, "x"] }, ingress: { applied: [], unmapped: [{ field: "ports", reason: "r" }] } }, output: null, startedAt: null, finishedAt: null },
          { itemRef: "app:srv:api", kind: "app", status: "DONE", resourceType: "application", resourceId: "app2", result: { name: "api", postCreate: "garbage" }, output: null, startedAt: null, finishedAt: null },
          { itemRef: "app:srv:db", kind: "database", status: "DONE", resourceType: "database", resourceId: "d1", result: { name: "db" }, output: null, startedAt: null, finishedAt: null },
        ],
      }),
    );
    expect(v.tasks[0].postCreate).toEqual({ applied: ["build", "customLabels"], unmapped: [{ field: "customLabel:traefik.enable", reason: "reserved" }] });
    expect(v.tasks[0].ingress).toEqual({ applied: [], unmapped: [{ field: "ports", reason: "r" }] });
    expect(v.tasks[1].postCreate).toBeUndefined();
    expect(v.tasks[2].postCreate).toBeUndefined();
    expect(v.tasks[2].ingress).toBeUndefined();
  });

  it("returns the strict-env key NAMES and the git outcome (status, source name, PUBLIC key) and drops malformed entries", () => {
    const v = toStatusView(
      op({
        tasks: [
          { itemRef: "app:srv:web", kind: "app", status: "DONE", resourceType: "application", resourceId: "a1", result: { name: "web", unresolvedKeys: ["A", 7, "B"], droppedInvalidKeys: ["X Y"], git: { status: "ssh_deploy_key", deployKeyPublic: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 tugra", privateKey: "LEAK" } }, output: null, startedAt: null, finishedAt: null },
          { itemRef: "app:srv:api", kind: "app", status: "DONE", resourceType: "application", resourceId: "a2", result: { name: "api", git: { status: "linked", sourceName: "Acme", rewritten: true } }, output: null, startedAt: null, finishedAt: null },
          { itemRef: "app:srv:bad", kind: "app", status: "DONE", resourceType: "application", resourceId: "a3", result: { name: "bad", git: { status: "weird" }, unresolvedKeys: [] }, output: null, startedAt: null, finishedAt: null },
          { itemRef: "app:srv:plain", kind: "app", status: "DONE", resourceType: "application", resourceId: "a4", result: { name: "plain" }, output: null, startedAt: null, finishedAt: null },
        ],
      }),
    );
    expect(v.tasks[0].unresolvedKeys).toEqual(["A", "B"]);
    expect(v.tasks[0].droppedInvalidKeys).toEqual(["X Y"]);
    expect(v.tasks[0].git).toEqual({ status: "ssh_deploy_key", deployKeyPublic: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 tugra" });
    expect(JSON.stringify(v)).not.toContain("LEAK");
    expect(v.tasks[1].git).toEqual({ status: "linked", sourceName: "Acme", rewritten: true });
    expect(v.tasks[2].git).toBeUndefined();
    expect(v.tasks[2].unresolvedKeys).toBeUndefined();
    expect(v.tasks[3].git).toBeUndefined();
  });
});

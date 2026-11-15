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

describe("toStatusView — service tasks", () => {
  const mk = (result: unknown) => ({ id: "op", planId: "h", meta: { sourceKind: "coolify" }, cancelRequestedAt: null, createdAt: new Date(), tasks: [{ itemRef: "service:s:1", kind: "service", status: "DONE", resourceType: "application", resourceId: "a1", output: null, result, startedAt: null, finishedAt: null }] });
  it("projects only the known secret-free fields of a service result", () => {
    const view = toStatusView(mk({ kind: "service", name: "svc", appId: "a1", members: ["a"], dropped: [{ field: "a.ports", reason: "r" }], configMounts: 2, serviceDomains: { applied: 1, unmapped: [] }, privateNetwork: { network: "svc-x", alias: "a" }, volumes: [{ key: "v", dockerName: "tugra_a1_v", policy: "copy", dataPlane: "hub-staged", state: "pending-data" }], hold: true, checklist: [{ kind: "tunnel", severity: "warn", params: { name: "svc", bad: { nested: 1 } } }], leaked: "SECRET" }) as never);
    const task = view.tasks[0] as { service?: Record<string, unknown> };
    expect(task.service).toMatchObject({ members: ["a"], configMounts: 2, hold: true, privateNetwork: { network: "svc-x", alias: "a" } });
    expect((task.service as { checklist: Array<{ params: object }> }).checklist[0].params).toEqual({ name: "svc" });
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });
  it("a non-service task carries no service field", () => {
    const view = toStatusView(mk({ name: "web", appId: "a1" }) as never);
    expect(view.tasks[0]).not.toHaveProperty("service");
  });
});

describe("toStatusView with data tasks", () => {
  const done = { itemRef: "app:srv:web", kind: "app", status: "DONE", resourceType: "application", resourceId: "app1", result: {}, output: null, startedAt: null, finishedAt: null };
  const data = (itemRef: string, status: string) => ({ itemRef, kind: "data", status, resourceType: null, resourceId: null, result: {}, output: null, startedAt: null, finishedAt: null });

  it("a RUNNING streamed volume copy (data:volume:*, hours long) does NOT keep the import reading RUNNING, so the post-import panel stays visible", () => {
    const v = toStatusView(op({ tasks: [done, data("data:volume:srv1:5f3a9c:data", "RUNNING")] }));
    expect(v.status).toBe("SUCCEEDED");
    expect(v.totals).toMatchObject({ total: 1, done: 1, running: 0 });
  });

  it("a v1 data task (short restore) still counts exactly as before", () => {
    const v = toStatusView(op({ tasks: [done, data("data:database:srv:pg", "RUNNING")] }));
    expect(v.status).toBe("RUNNING");
    expect(v.totals).toMatchObject({ total: 2, running: 1 });
    expect(toStatusView(op({ tasks: [done, data("data:vol:app:srv:web:data", "RUNNING")] })).status).toBe("RUNNING");
  });
});

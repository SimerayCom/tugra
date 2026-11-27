import { planImport, ENV_RISK_UNRESOLVED, ENV_RISK_INVALID, ENV_RISK_TOKEN_READ_ONLY, ENV_RISK_CONSENT_REQUIRED, ENV_RISK_PREVIEW } from "./import-planner";
import type { ForeignApp, ForeignFleet } from "./foreign-fleet";

const app = (over: Partial<ForeignApp> = {}): ForeignApp => ({ sourceRef: "a1", name: "web", kind: "git", buildPack: "nixpacks", git: { url: "https://github.com/o/r.git" }, serverRef: "s1", env: [], ...over });
const fleet = (apps: ForeignApp[]): ForeignFleet => ({ servers: [], apps, databases: [], services: [], volumes: [], sharedEnv: [], warnings: [] });
const report = (over: Partial<NonNullable<ForeignApp["envReport"]>> = {}): NonNullable<ForeignApp["envReport"]> => ({ total: 4, previewSkipped: 0, unresolved: [], invalidKeys: [], tokenReadOnly: false, ...over });
const risksOf = (f: ForeignFleet) => planImport(f, { sourceKind: "coolify" }).items.find((i) => i.kind === "app")!.risks;

describe("planImport — strict env rows (Coolify envReport only)", () => {
  it("an unresolved key becomes an ackable blocker naming the key + reason code, never a value", () => {
    const r = risksOf(fleet([app({ envReport: report({ unresolved: [{ key: "SHARED_TOKEN", reason: "SHARED_UNEXPANDED" }, { key: "SERVICE_FQDN_WEB", reason: "MAGIC" }] }) })]));
    const row = r.find((x) => x.code === ENV_RISK_UNRESOLVED)!;
    expect(row.level).toBe("blocker");
    expect(row.message).toBe("2 variable(s) cannot be carried and will be missing in the new app: SHARED_TOKEN (SHARED_UNEXPANDED), SERVICE_FQDN_WEB (MAGIC)");
  });

  it("invalid keys are an ackable blocker (names only); a preview twin count is info", () => {
    const r = risksOf(fleet([app({ envReport: report({ invalidKeys: ["A=B", "__proto__"], previewSkipped: 3 }) })]));
    expect(r.find((x) => x.code === ENV_RISK_INVALID)).toMatchObject({ level: "blocker", message: expect.stringContaining("A=B, __proto__") });
    expect(r.find((x) => x.code === ENV_RISK_PREVIEW)).toEqual({ level: "info", code: ENV_RISK_PREVIEW, message: "3 preview-environment variable(s) are not imported" });
  });

  it("tokenReadOnly is ONE actionable blocker and suppresses the per-key unresolved row", () => {
    const keys = Array.from({ length: 40 }, (_, i) => ({ key: `K${i}`, reason: "NO_VALUE" as const }));
    const r = risksOf(fleet([app({ envReport: report({ tokenReadOnly: true, unresolved: keys }) })]));
    expect(r.filter((x) => x.level === "blocker" && x.code.startsWith("app.env."))).toEqual([
      { level: "blocker", code: ENV_RISK_TOKEN_READ_ONLY, message: "the API token cannot read variable values; create a Coolify token with the read:sensitive ability and reconnect" },
    ]);
  });

  it("awaitingConsent (agent session, no consent) is ONE blocker that says to allow secret values, never a token, and wins over per-key rows", () => {
    const keys = [{ key: "K1", reason: "NO_VALUE" as const }];
    const r = risksOf(fleet([app({ envReport: report({ awaitingConsent: true, unresolved: keys }) })]));
    const blockers = r.filter((x) => x.level === "blocker" && x.code.startsWith("app.env."));
    expect(blockers).toHaveLength(1);
    expect(blockers[0].code).toBe(ENV_RISK_CONSENT_REQUIRED);
    expect(blockers[0].message).toMatch(/allow reading secret values/);
    expect(blockers[0].message).not.toMatch(/token|read:sensitive/i);
  });

  it("lists the first 40 names then '+M more'", () => {
    const keys = Array.from({ length: 55 }, (_, i) => ({ key: `K${String(i).padStart(2, "0")}`, reason: "NO_VALUE" as const }));
    const msg = risksOf(fleet([app({ envReport: report({ unresolved: keys }) })])).find((x) => x.code === ENV_RISK_UNRESOLVED)!.message;
    expect(msg).toContain("K39 (NO_VALUE) (+15 more)");
    expect(msg).not.toContain("K40");
  });

  it("a clean report adds no rows; counts as blockers only for the strict rows", () => {
    const p = planImport(fleet([app({ envReport: report() })]), { sourceKind: "coolify" });
    expect(p.items[0].risks.some((x) => x.code.startsWith("app.env."))).toBe(false);
    const q = planImport(fleet([app({ envReport: report({ unresolved: [{ key: "A", reason: "NO_VALUE" }], invalidKeys: ["B C"] }) })]), { sourceKind: "coolify" });
    expect(q.totals.blockers).toBe(2);
  });

  it("source WITHOUT envReport (Dokploy/local) is byte-identical: same items, same planHash", () => {
    const plain = fleet([app()]);
    const a = planImport(plain, { sourceKind: "dokploy" });
    const withUndefined = planImport(fleet([app({ envReport: undefined })]), { sourceKind: "dokploy" });
    expect(withUndefined.planHash).toBe(a.planHash);
    expect(JSON.stringify(withUndefined.items)).toBe(JSON.stringify(a.items));
    // no strict env row is ever emitted without an envReport
    expect(a.items[0].risks.some((x) => x.code.startsWith("app.env.") && x.code !== "app.env.unresolvable")).toBe(false);
  });

  it("is independent of discovery order (planHash stable)", () => {
    const r1 = report({ unresolved: [{ key: "A", reason: "NO_VALUE" }, { key: "B", reason: "MAGIC" }] });
    const f1 = fleet([app({ sourceRef: "a1", envReport: r1 }), app({ sourceRef: "a2", name: "api", envReport: report({ invalidKeys: ["X Y"] }) })]);
    const f2 = fleet([...f1.apps].reverse());
    expect(planImport(f2, { sourceKind: "coolify" }).planHash).toBe(planImport(f1, { sourceKind: "coolify" }).planHash);
  });
});

import {
  ImportMappingDocSchema,
  NAME_MAX,
  validateName,
  canonicalJson,
  normalizeBaseUrl,
  resolveMapping,
  blockingErrors,
  unackedConflicts,
  isEmptyDoc,
  docHash,
  type ImportMappingDoc,
  type TargetSnapshot,
  type ResolveOpts,
} from "./import-mapping";
import { planImport } from "./import-planner";
import { isRunnable, skipReason, isAcked, hasUnackedBlocker } from "./import-executor.logic";
import type { ForeignFleet } from "./foreign-fleet";
import { ownerFleet, BIG_DB_REF } from "./__fixtures__/owner-fleet.scrubbed";

const doc = (over: Partial<ImportMappingDoc> = {}): ImportMappingDoc => ImportMappingDocSchema.parse({ version: 1, ...over });
const APP1 = "app:srv-1:app-01";
const APP2 = "app:srv-1:app-02";
const DB1 = "database:srv-1:db-1";

function snap(over: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    teamId: "t1",
    serverId: "srv-t",
    canCreateProjects: true,
    projects: new Map(),
    envIds: new Set(["env-sel"]),
    defaultEnvironmentId: "env-def",
    namesByEnv: new Map(),
    aliasesOnServer: new Set(),
    existing: new Map(),
    elsewhere: new Map(),
    gitSourcesByAppId: new Set(),
    ...over,
  };
}
const opts = (plan: { planHash: string }, over: Partial<ResolveOpts> = {}): ResolveOpts => ({ planHash: plan.planHash, targetServerId: "srv-t", reconcile: false, session: { sourceKind: "coolify", scopeKey: "" }, ...over });

function small(): ForeignFleet {
  return {
    servers: [{ ref: "srv-1" }],
    apps: [
      { sourceRef: "app-01", name: "web", kind: "git", buildPack: "dockerfile", git: { url: "o/r", branch: "main" }, ports: [3000], serverRef: "srv-1" },
      { sourceRef: "app-02", name: "worker", kind: "image", buildPack: "image", image: "nginx:1", serverRef: "srv-1" },
      { sourceRef: "app-03", name: "stack", kind: "compose", buildPack: "dockercompose", composeFile: "services: {}", serverRef: "srv-1" },
    ],
    databases: [{ sourceRef: "db-1", name: "orders", engine: "POSTGRES", version: "16", serverRef: "srv-1" }],
    services: [],
    volumes: [],
    sharedEnv: [],
    warnings: [],
  };
}

/** A Dokploy-shaped fleet with a project/environment tree. */
function tree(): ForeignFleet {
  const f = small();
  f.apps[0].projectRef = "p1";
  f.apps[0].environmentRef = "e1";
  f.apps[1].projectRef = "p2";
  f.apps[1].environmentRef = "e2";
  f.databases[0].projectRef = "p1";
  f.databases[0].environmentRef = "e1";
  f.projects = [
    { ref: "p1", name: "Shop", tags: [], environments: [{ ref: "e1", name: "production", isDefault: true }] },
    { ref: "p2", name: "Ops", tags: [], environments: [{ ref: "e2", name: "staging", isDefault: true }] },
  ];
  return f;
}

const run = (fleet: ForeignFleet, d: ImportMappingDoc, s: TargetSnapshot | null = snap(), o: Partial<ResolveOpts> = {}) => {
  const plan = planImport(fleet, { sourceKind: "coolify" });
  return { plan, res: resolveMapping(fleet, plan, d, s, opts(plan, o)) };
};
const codes = (r: { conflicts: Array<{ code: string }> }) => r.conflicts.map((c) => c.code);

describe("ImportMappingDocSchema", () => {
  it("accepts a minimal doc and defaults the collections", () => {
    const d = ImportMappingDocSchema.parse({ version: 1 });
    expect(d).toEqual({ version: 1, items: {}, projects: {}, gitSources: {}, acks: [] });
  });
  it("is strict at every level (unknown key -> reject)", () => {
    expect(ImportMappingDocSchema.safeParse({ version: 1, rules: [] }).success).toBe(false);
    expect(ImportMappingDocSchema.safeParse({ version: 1, items: { [APP1]: { nme: "x" } } }).success).toBe(false);
    expect(ImportMappingDocSchema.safeParse({ version: 1, scope: { sourceKind: "coolify", extra: 1 } }).success).toBe(false);
    expect(ImportMappingDocSchema.safeParse({ version: 1, projects: { p1: { name: "x", color: "red" } } }).success).toBe(false);
    expect(ImportMappingDocSchema.safeParse({ version: 1, gitSources: { g: { name: "x", z: 1 } } }).success).toBe(false);
    expect(ImportMappingDocSchema.safeParse({ version: 2 }).success).toBe(false);
  });
  it("rejects volume keys, garbage keys and reserved ref keys", () => {
    expect(ImportMappingDocSchema.safeParse({ version: 1, items: { "volume:srv-1:v": { name: "x" } } }).success).toBe(false);
    expect(ImportMappingDocSchema.safeParse({ version: 1, items: { "app: with space": { name: "x" } } }).success).toBe(false);
    expect(ImportMappingDocSchema.safeParse(JSON.parse('{"version":1,"projects":{"__proto__":{"name":"x"}}}')).success).toBe(false);
  });
  it("bounds the item count and the ack list", () => {
    expect(ImportMappingDocSchema.safeParse({ version: 1, acks: Array(5001).fill("a") }).success).toBe(false);
    const items: Record<string, unknown> = {};
    for (let i = 0; i < 5001; i++) items[`app:s:${i}`] = {};
    expect(ImportMappingDocSchema.safeParse({ version: 1, items }).success).toBe(false);
  });
  it("bounds a candidate name's raw length (the policy cap is enforced by validateName)", () => {
    expect(ImportMappingDocSchema.safeParse({ version: 1, items: { [APP1]: { name: "x".repeat(401) } } }).success).toBe(false);
    expect(ImportMappingDocSchema.safeParse({ version: 1, items: { [APP1]: { name: "x".repeat(300) } } }).success).toBe(true);
  });
});

/** The shared name-policy vector table — mirrored literally in the web spec (apps/web/src/lib/import-mapping.test.ts). */
export const NAME_VECTORS: Array<{ kind: keyof typeof NAME_MAX; input: string; ok: boolean; value?: string; code?: string }> = [
  { kind: "app", input: "  web  ", ok: true, value: "web" },
  { kind: "app", input: "", ok: false, code: "name.invalid" },
  { kind: "app", input: "   ", ok: false, code: "name.invalid" },
  { kind: "app", input: "café", ok: true, value: "café" }, // NFC
  { kind: "app", input: "a".repeat(100), ok: true, value: "a".repeat(100) },
  { kind: "app", input: "a".repeat(101), ok: false, code: "name.too_long" },
  { kind: "database", input: "d".repeat(60), ok: true, value: "d".repeat(60) },
  { kind: "database", input: "d".repeat(61), ok: false, code: "name.too_long" },
  { kind: "project", input: "p".repeat(80), ok: true, value: "p".repeat(80) },
  { kind: "project", input: "p".repeat(81), ok: false, code: "name.too_long" },
  { kind: "environment", input: "e".repeat(81), ok: false, code: "name.too_long" },
  { kind: "gitsource", input: "g".repeat(81), ok: false, code: "name.too_long" },
  { kind: "database", input: "\u{1F600}".repeat(60), ok: true, value: "\u{1F600}".repeat(60) }, // 60 code points (120 UTF-16 units)
  { kind: "database", input: "\u{1F600}".repeat(61), ok: false, code: "name.too_long" },
  { kind: "project", input: "\u{1F600}".repeat(40), ok: true, value: "\u{1F600}".repeat(40) }, // 80 UTF-16 units
  { kind: "project", input: "\u{1F600}".repeat(41), ok: false, code: "name.too_long" }, // 41 code points but 82 units (the project service slices by unit)
  { kind: "app", input: "a‮b", ok: false, code: "name.invalid" }, // bidi override
  { kind: "app", input: "a⁦b", ok: false, code: "name.invalid" }, // bidi isolate
  { kind: "app", input: "a​b", ok: false, code: "name.invalid" }, // zero-width space
  { kind: "app", input: "a‍b", ok: false, code: "name.invalid" }, // zero-width joiner
  { kind: "app", input: "a⁠b", ok: false, code: "name.invalid" }, // word joiner
  { kind: "app", input: "a﻿b", ok: false, code: "name.invalid" }, // BOM inside
  { kind: "app", input: "a\u0000b", ok: false, code: "name.invalid" }, // control
  { kind: "app", input: "a\tb", ok: false, code: "name.invalid" }, // control
  { kind: "app", input: "a\nb", ok: false, code: "name.invalid" }, // control
];

describe("validateName (shared parity table)", () => {
  it.each(NAME_VECTORS)("$kind %j", (v) => {
    const r = validateName(v.kind, v.input);
    if (v.ok) expect(r).toEqual({ ok: true, value: v.value });
    else expect(r).toEqual({ ok: false, code: v.code });
  });
  it("never truncates: an over-long name is rejected, not sliced", () => {
    expect(validateName("project", "x".repeat(90)).ok).toBe(false);
  });
});

describe("canonicalJson / normalizeBaseUrl", () => {
  it("sorts keys, drops null/undefined/empty objects, NFC-normalises strings", () => {
    expect(canonicalJson({ b: 1, a: { z: null, y: undefined, k: {} }, c: "é" })).toBe('{"b":1,"c":"é"}');
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
  it.each([
    ["HTTPS://Coolify.Example.com/", "https://coolify.example.com"],
    ["https://coolify.example.com:443", "https://coolify.example.com"],
    ["http://h.example.com:80/", "http://h.example.com"],
    ["https://h.example.com:8443/x/?q=1#f", "https://h.example.com:8443/x"],
    ["https://user:pw@h.example.com/", "https://h.example.com"],
  ])("%s", (raw, want) => expect(normalizeBaseUrl(raw)).toBe(want));
});

describe("isRunnable / skipReason (extracted loop predicate)", () => {
  const f = small();
  const plan = planImport(f, { sourceKind: "coolify" });
  const item = (ref: string) => plan.items.find((i) => i.itemRef === ref)!;
  it("matches the legacy inline logic over a matrix", () => {
    for (const it of plan.items) {
      const app = it.kind === "app" ? f.apps.find((a) => `app:srv-1:${a.sourceRef}` === it.itemRef) : undefined;
      const db = it.kind === "database" ? f.databases.find((d) => `database:srv-1:${d.sourceRef}` === it.itemRef) : undefined;
      for (const dup of [false, true]) {
        const hasBlocker = it.risks.some((r) => r.level === "blocker");
        const prov = !!db && ["POSTGRES", "MYSQL", "REDIS", "MONGO", "MARIADB", "KEYDB", "DRAGONFLY", "CLICKHOUSE", "LIBSQL"].includes(db.engine);
        const legacy = !dup && !hasBlocker && ((it.kind === "app" && !!app) || (it.kind === "database" && prov));
        expect(isRunnable(it, app, db, dup)).toBe(legacy);
      }
    }
  });
  it("risk acks lift only an ackable blocker the ack covers (matrix)", () => {
    const blocked = { itemRef: APP1, kind: "app" as const, risks: [{ level: "blocker" as const, code: "app.env.unresolved", message: "m" }] };
    const app = f.apps[0];
    expect(isRunnable(blocked, app, undefined, false)).toBe(false);
    expect(isRunnable(blocked, app, undefined, false, [])).toBe(false);
    expect(isRunnable(blocked, app, undefined, false, [{ code: "app.env.unresolved" }])).toBe(true);
    expect(isRunnable(blocked, app, undefined, false, [{ code: "app.env.unresolved", itemRef: APP1 }])).toBe(true);
    expect(isRunnable(blocked, app, undefined, false, [{ code: "app.env.unresolved", itemRef: "app:srv-1:other" }])).toBe(false); // another item's ack
    expect(isRunnable(blocked, app, undefined, false, [{ code: "app.env.key.invalid" }])).toBe(false); // another code
    expect(isRunnable(blocked, app, undefined, true, [{ code: "app.env.unresolved" }])).toBe(false); // dup still wins
    const hard = { itemRef: APP1, kind: "app" as const, risks: [{ level: "blocker" as const, code: "app.env.tokenReadOnly", message: "m" }] };
    expect(isRunnable(hard, app, undefined, false, [{ code: "app.env.tokenReadOnly" }])).toBe(false); // never ackable
    expect(hasUnackedBlocker(blocked, [{ code: "app.env.unresolved" }])).toBe(false);
    expect(isAcked(undefined, APP1, "app.env.unresolved")).toBe(false);
    expect(skipReason(blocked, undefined, false, [{ code: "app.env.unresolved" }])).toBe("could not resolve the source resource");
    expect(skipReason(blocked, undefined, false)).toBe("blocked by a plan risk");
  });
  it("reasons keep their exact text", () => {
    expect(skipReason(item(APP1), undefined, true)).toBe("already imported onto this server in a previous run");
    expect(skipReason({ kind: "app", risks: [{ level: "blocker", code: "x", message: "m" }] }, undefined, false)).toBe("blocked by a plan risk");
    expect(skipReason({ kind: "volume", risks: [] }, undefined, false)).toMatch(/handled with its owning app/);
    expect(skipReason({ kind: "database", risks: [] }, { sourceRef: "d", name: "d", engine: "UNKNOWN" }, false)).toBe("database engine has no Tugra equivalent");
    expect(skipReason({ kind: "app", risks: [] }, undefined, false)).toBe("could not resolve the source resource");
  });
});

describe("resolveMapping — names", () => {
  it("an empty doc resolves every item to its source name with no conflicts", () => {
    const { res } = run(small(), doc());
    expect(res.effective.map((e) => e.name)).toEqual(expect.arrayContaining(["web", "worker", "orders"]));
    expect(res.effective.every((e) => e.origin.name === "source" && e.changed.length === 0)).toBe(true);
    expect(blockingErrors(res)).toEqual([]);
    expect(unackedConflicts(res)).toEqual([]);
  });
  it("renames an app and a database; origin is mapping", () => {
    const { res } = run(small(), doc({ items: { [APP1]: { name: " Web Front " }, [DB1]: { name: "orders-db" } } }));
    const a = res.effective.find((e) => e.itemRef === APP1)!;
    expect(a).toMatchObject({ name: "Web Front", sourceName: "web", origin: { name: "mapping" } });
    expect(a.changed).toContain("name");
    expect(res.effective.find((e) => e.itemRef === DB1)!.name).toBe("orders-db");
    expect(res.counts.renamed).toBe(2);
  });
  it("a rename equal to the source name is not a change", () => {
    const { res } = run(small(), doc({ items: { [APP1]: { name: "web" } } }));
    expect(res.effective.find((e) => e.itemRef === APP1)!.changed).toEqual([]);
  });
  it("rejects invalid / over-long names per kind (DB cap is 60)", () => {
    const { res } = run(small(), doc({ items: { [APP1]: { name: "a".repeat(101) }, [DB1]: { name: "d".repeat(61) }, [APP2]: { name: "a​b" } } }));
    expect(res.conflicts.filter((c) => c.level === "error").map((c) => [c.itemRef, c.code])).toEqual(
      expect.arrayContaining([[APP1, "name.too_long"], [DB1, "name.too_long"], [APP2, "name.invalid"]]),
    );
  });
});

describe("resolveMapping — placement precedence", () => {
  it("item placement beats the Dokploy tree (with renames) beats environmentId beats default", () => {
    const f = tree();
    const sel = run(f, doc(), snap(), { environmentId: "env-sel" }).res;
    expect(sel.effective.find((e) => e.itemRef === APP1)).toMatchObject({ project: "Shop", environment: "production", origin: { placement: "tree" } });
    const renamed = run(f, doc({ projects: { p1: { name: "Store", environments: { e1: "live" } } } }), snap()).res;
    expect(renamed.effective.find((e) => e.itemRef === APP1)).toMatchObject({ project: "Store", environment: "live", origin: { placement: "tree" } });
    const item = run(f, doc({ projects: { p1: { name: "Store" } }, items: { [APP1]: { project: "Custom", environment: "qa" } } }), snap()).res;
    expect(item.effective.find((e) => e.itemRef === APP1)).toMatchObject({ project: "Custom", environment: "qa", origin: { placement: "mapping" } });
    // a source with no tree: the selected env, else the default
    const sm = run(small(), doc(), snap(), { environmentId: "env-sel" }).res;
    expect(sm.effective[0]).toMatchObject({ project: null, environment: null, origin: { placement: "selected" } });
    expect(run(small(), doc()).res.effective[0].origin.placement).toBe("default");
  });
  it("a project without an environment lands in the literal production environment", () => {
    const { res } = run(small(), doc({ items: { [APP1]: { project: "Ops" } } }));
    expect(res.effective.find((e) => e.itemRef === APP1)).toMatchObject({ project: "Ops", environment: "production" });
  });
  it("an environment without any project is an error (no silent guess)", () => {
    const { res } = run(small(), doc({ items: { [APP1]: { environment: "qa" } } }));
    expect(codes(res)).toContain("placement.project_required");
  });
  it("an environment alone re-targets the tree project's environment", () => {
    const { res } = run(tree(), doc({ items: { [APP1]: { environment: "qa" } } }));
    expect(res.effective.find((e) => e.itemRef === APP1)).toMatchObject({ project: "Shop", environment: "qa", origin: { placement: "mapping" } });
  });
  it("validates project / environment names", () => {
    const { res } = run(small(), doc({ items: { [APP1]: { project: "p".repeat(81), environment: "e‮x" } } }));
    expect(codes(res)).toEqual(expect.arrayContaining(["name.too_long", "name.invalid"]));
  });
  it("only creates the projects/environments that runnable items use (empty-project suppression)", () => {
    const f = tree();
    const { res } = run(f, doc({ items: { [APP2]: { include: false } } }), snap());
    expect(res.projects.map((p) => p.name)).toEqual(["Shop"]); // Ops has only an excluded app
    expect(res.counts.newProjects).toBe(1);
    expect(codes(res)).toContain("tree.not_rolled_back");
  });
  it("reports the project/env that would be created and merges into an existing one with an ack requirement", () => {
    const s = snap({ projects: new Map([["Shop", { id: "p", envs: new Map([["production", "env-p"]]) }]]), namesByEnv: new Map([["env-p", { apps: new Map([["old", "a1"]]), dbs: new Map() }]]) });
    const { res } = run(tree(), doc(), s);
    const merge = res.conflicts.find((c) => c.code === "project.merge_existing")!;
    expect(merge).toMatchObject({ requiresAck: true, ackKey: "project.merge_existing:shop", params: { existing: 1 }, acked: false });
    expect(res.projects.find((p) => p.name === "Shop")).toMatchObject({ willCreate: false, envsToCreate: [] });
    expect(res.projects.find((p) => p.name === "Ops")).toMatchObject({ willCreate: true, envsToCreate: ["staging"] });
    const acked = run(tree(), doc({ acks: ["project.merge_existing:shop"] }), s).res;
    expect(unackedConflicts(acked)).toEqual([]);
  });
  it("two source projects mapped onto one target name needs an ack", () => {
    const { res } = run(tree(), doc({ items: { [APP1]: { project: "Merged", environment: "production" }, [APP2]: { project: "Merged", environment: "production" } } }));
    expect(res.conflicts.find((c) => c.code === "project.merge_sources")).toMatchObject({ ackKey: "project.merge_sources:merged", requiresAck: true });
  });
  it("perm.projects: no projects permission while the doc needs a project created is an ERROR, no fallback", () => {
    const { res } = run(small(), doc({ items: { [APP1]: { project: "New" } } }), snap({ canCreateProjects: false }));
    expect(blockingErrors(res).map((c) => c.code)).toContain("perm.projects");
    // nothing to create -> not an error
    const s = snap({ canCreateProjects: false, projects: new Map([["New", { id: "p", envs: new Map([["production", "e"]]) }]]) });
    expect(blockingErrors(run(small(), doc({ items: { [APP1]: { project: "New" } } }), s).res).map((c) => c.code)).not.toContain("perm.projects");
  });
  it("env.not_in_team", () => {
    expect(codes(run(small(), doc(), snap(), { environmentId: "nope" }).res)).toContain("env.not_in_team");
  });
  it("name.case_only: matches an existing project only in case", () => {
    const s = snap({ projects: new Map([["shop", { id: "p", envs: new Map() }]]) });
    expect(codes(run(small(), doc({ items: { [APP1]: { project: "Shop" } } }), s).res)).toContain("name.case_only");
  });
  it("info for the Dokploy synthetic production environment", () => {
    const f = tree();
    f.apps[0].environmentRef = "p1#production";
    f.projects![0].environments = [{ ref: "p1#production", name: "production", isDefault: true }];
    expect(codes(run(f, doc()).res)).toContain("placement.synthetic");
  });
});

describe("resolveMapping — duplicates", () => {
  const two = () => {
    const f = small();
    f.apps.push({ sourceRef: "app-04", name: "web", kind: "git", buildPack: "dockerfile", git: { url: "o/r2", branch: "main" }, serverRef: "srv-1" });
    return f;
  };
  it("same kind + same effective environment + case-insensitive name needs an ack; acks lift it", () => {
    const { res } = run(two(), doc({ items: { [APP2]: { name: "WEB" } } }));
    expect(res.conflicts.filter((c) => c.code === "name.duplicate").length).toBeGreaterThanOrEqual(2);
    expect(unackedConflicts(res).length).toBeGreaterThan(0);
    const acked = run(two(), doc({ items: { [APP2]: { name: "WEB" } }, acks: res.conflicts.filter((c) => c.ackKey).map((c) => c.ackKey!) })).res;
    expect(unackedConflicts(acked)).toEqual([]);
  });
  it("the same name in different (project, environment) pairs passes with no ack", () => {
    const { res } = run(two(), doc({ items: { "app:srv-1:app-04": { project: "Other" } } }));
    expect(codes(res)).not.toContain("name.duplicate");
  });
  it("an app and a database with the same name are not duplicates (different kinds)", () => {
    const { res } = run(small(), doc({ items: { [DB1]: { name: "web" } } }));
    expect(codes(res)).not.toContain("name.duplicate");
  });
  it("conflicts with a resource already in the target environment", () => {
    const s = snap({ namesByEnv: new Map([["env-def", { apps: new Map([["web", "a"]]), dbs: new Map() }]]) });
    expect(codes(run(small(), doc(), s).res)).toContain("name.duplicate");
    const sel = snap({ namesByEnv: new Map([["env-sel", { apps: new Map([["web", "a"]]), dbs: new Map() }]]) });
    expect(codes(run(small(), doc(), sel, { environmentId: "env-sel" }).res)).toContain("name.duplicate");
  });
  it("an excluded item never counts", () => {
    const { res } = run(two(), doc({ items: { "app:srv-1:app-04": { include: false } } }));
    expect(codes(res)).not.toContain("name.duplicate");
  });
});

describe("resolveMapping — alias and db identifier", () => {
  const a = (alias: string | null, ref = APP1) => doc({ items: { [ref]: { containerAlias: alias } } });
  it("accepts a valid alias and tags the origin", () => {
    const { res } = run(small(), a("web-api"));
    expect(res.effective.find((e) => e.itemRef === APP1)).toMatchObject({ containerAlias: "web-api", origin: { alias: "mapping" } });
    expect(res.counts.aliased).toBe(1);
  });
  it("alias.invalid / alias.reserved (case-insensitive tugra[-_])", () => {
    expect(codes(run(small(), a("Web_API")).res)).toContain("alias.invalid");
    expect(codes(run(small(), a("-x")).res)).toContain("alias.invalid");
    expect(codes(run(small(), a("tugra-x")).res)).toContain("alias.reserved");
    expect(codes(run(small(), a("tugra")).res)).not.toContain("alias.reserved"); // only tugra- / tugra_ prefixes
  });
  it("alias.taken: duplicate in the doc and on the server, case-insensitive", () => {
    const d = doc({ items: { [APP1]: { containerAlias: "same" }, [APP2]: { containerAlias: "same" } } });
    expect(codes(run(small(), d).res)).toContain("alias.taken");
    expect(codes(run(small(), a("busy"), snap({ aliasesOnServer: new Set(["busy"]) })).res)).toContain("alias.taken");
  });
  it("alias.unsupported: on a database, on a COMPOSE app, on an excluded item", () => {
    expect(codes(run(small(), a("x", DB1)).res)).toContain("alias.unsupported");
    expect(codes(run(small(), a("x", "app:srv-1:app-03")).res)).toContain("alias.unsupported");
    expect(codes(run(small(), doc({ items: { [APP1]: { include: false, containerAlias: "x" } } })).res)).toContain("alias.unsupported");
  });
  it("db.identifier_*: invalid, on an app, on an imported DB; a valid one on a fresh DB is a warning", () => {
    const di = (id: string, ref = DB1) => doc({ items: { [ref]: { dbIdentifier: id } } });
    expect(codes(run(small(), di("Bad-Id")).res)).toContain("db.identifier_invalid");
    expect(codes(run(small(), di("ok_id", APP1)).res)).toContain("db.identifier_on_app");
    const imported = snap({ existing: new Map([[DB1, { resourceType: "database", resourceId: "d1", name: "orders", environmentId: "env-def" }]]) });
    expect(codes(run(small(), di("ok_id"), imported).res)).toContain("db.identifier_on_imported");
    const ok = run(small(), di("ok_id")).res;
    expect(ok.conflicts.find((c) => c.code === "db.identifier_fresh_only")).toMatchObject({ level: "warn" });
    expect(ok.effective.find((e) => e.itemRef === DB1)).toMatchObject({ dbIdentifier: "ok_id", origin: { dbIdentifier: "mapping" } });
  });
  it("a DB rename warns that the identifier is kept", () => {
    expect(codes(run(small(), doc({ items: { [DB1]: { name: "renamed" } } })).res)).toContain("db.rename_identifier_kept");
  });
});

describe("resolveMapping — misc conflicts", () => {
  it("orphans: keys the fresh plan no longer has (and volume refs)", () => {
    const { res } = run(small(), doc({ items: { "app:srv-1:gone": { name: "x" } } }));
    expect(res.orphans).toEqual(["app:srv-1:gone"]);
    expect(res.conflicts.find((c) => c.code === "key.orphan")).toMatchObject({ level: "error", itemRef: "app:srv-1:gone" });
    expect(blockingErrors(res)).toEqual([]); // orphans raise their own 409, not the 422 list
  });
  it("scope.mismatch against the session", () => {
    const ok = run(small(), doc({ scope: { sourceKind: "coolify", scopeKey: "team-3" } }), snap(), { session: { sourceKind: "coolify", scopeKey: "team-3" } }).res;
    expect(codes(ok)).not.toContain("scope.mismatch");
    const bad = run(small(), doc({ scope: { sourceKind: "coolify", scopeKey: "team-3" } }), snap(), { session: { sourceKind: "coolify", scopeKey: "team-5" } }).res;
    expect(codes(bad)).toContain("scope.mismatch");
    expect(codes(run(small(), doc({ scope: { sourceKind: "dokploy" } })).res)).toContain("scope.mismatch");
  });
  it("item.imported_elsewhere needs an ack, unless the item is excluded or imported here", () => {
    const s = snap({ elsewhere: new Map([[APP1, { serverId: "other", serverName: "Other box" }]]) });
    const { res } = run(small(), doc(), s);
    expect(res.conflicts.find((c) => c.code === "item.imported_elsewhere")).toMatchObject({ requiresAck: true, ackKey: `item.imported_elsewhere:${APP1}`, params: { server: "Other box" } });
    expect(codes(run(small(), doc({ items: { [APP1]: { include: false } } }), s).res)).not.toContain("item.imported_elsewhere");
  });
  it("dep.excluded: an included app depending on an excluded database", () => {
    const f = small();
    f.apps[0].links = [{ kind: "database", ref: "db-1" }];
    expect(codes(run(f, doc({ items: { [DB1]: { include: false } } })).res)).toContain("dep.excluded");
  });
  it("git sources: named at create, exists-not-renamed warning, stale refs", () => {
    const f = small();
    f.gitProviders = [{ ref: "g1", kind: "github", appId: "123", appName: "Source App" }];
    const { res } = run(f, doc({ gitSources: { g1: { name: "Renamed" }, nope: { name: "x" } } }), snap({ gitSourcesByAppId: new Set(["123"]) }));
    expect(res.gitSources).toEqual([{ ref: "g1", sourceName: "Source App", name: "Renamed", exists: true }]);
    expect(codes(res)).toEqual(expect.arrayContaining(["gitsource.exists_not_renamed", "key.stale_ref"]));
  });
  it("excluded -> status excluded, counted; blocked items are marked blocked", () => {
    const f = small();
    const { res } = run(f, doc({ items: { [APP1]: { include: false } } }));
    expect(res.effective.find((e) => e.itemRef === APP1)!.status).toBe("excluded");
    expect(res.counts.excluded).toBe(1);
  });
  it("already-imported drift is reported (name mapped differs from the live resource)", () => {
    const s = snap({ existing: new Map([[APP1, { resourceType: "application", resourceId: "a1", name: "web", environmentId: "env-def", containerAlias: null }]]) });
    const { res } = run(small(), doc({ items: { [APP1]: { name: "web-v2" } } }), s);
    const e = res.effective.find((x) => x.itemRef === APP1)!;
    expect(e).toMatchObject({ status: "already_imported", drift: ["name"] });
    expect(res.conflicts.find((c) => c.code === "item.already_imported_drift")).toMatchObject({ level: "warn", params: { fields: "name", reconcile: 0 } });
    // no mapped difference -> no drift even if the live name was changed after import
    expect(run(small(), doc(), s).res.effective.find((x) => x.itemRef === APP1)!.drift).toBeUndefined();
  });
});

describe("mappingHash", () => {
  const base = () => run(small(), doc({ items: { [APP1]: { name: "web2" } } }));
  it("is stable across key order and NFC variants", () => {
    const a = run(small(), doc({ items: { [APP1]: { name: "café" }, [APP2]: { name: "w" } } })).res.mappingHash;
    const b = run(small(), doc({ items: { [APP2]: { name: "w" }, [APP1]: { name: "café" } } })).res.mappingHash;
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });
  it("changes with any field, any ack, planHash, server, environmentId and reconcile", () => {
    const h = base().res.mappingHash;
    const diff = [
      run(small(), doc({ items: { [APP1]: { name: "web3" } } })).res.mappingHash,
      run(small(), doc({ items: { [APP1]: { name: "web2", project: "P" } } })).res.mappingHash,
      run(small(), doc({ items: { [APP1]: { name: "web2", containerAlias: "x" } } })).res.mappingHash,
      run(small(), doc({ items: { [APP1]: { name: "web2" } }, acks: ["k"] })).res.mappingHash,
      run(small(), doc({ items: { [APP1]: { name: "web2" } } }), snap(), { targetServerId: "other" }).res.mappingHash,
      run(small(), doc({ items: { [APP1]: { name: "web2" } } }), snap(), { environmentId: "env-sel" }).res.mappingHash,
      run(small(), doc({ items: { [APP1]: { name: "web2" } } }), snap(), { reconcile: true }).res.mappingHash,
      run(small(), doc({ items: { [APP1]: { name: "web2" } } }), snap(), { planHash: "f".repeat(32) }).res.mappingHash,
    ];
    for (const d of diff) expect(d).not.toBe(h);
    expect(new Set(diff).size).toBe(diff.length);
  });
  it("ignores scope; an identity doc hashes equal to an empty doc", () => {
    const empty = run(small(), doc()).res.mappingHash;
    const identity = run(small(), doc({ scope: { sourceKind: "coolify" }, items: { [APP1]: { name: "web", include: true }, [DB1]: { name: "orders" } } })).res.mappingHash;
    expect(identity).toBe(empty);
    // acks are the same whether or not a snapshot is present
    expect(run(small(), doc(), null).res.mappingHash).toBe(empty);
  });
  it("does not depend on target conflict state (a concurrent manual create does not churn the hash)", () => {
    const d = doc({ items: { [APP1]: { name: "web2" } } });
    const a = run(small(), d, snap()).res.mappingHash;
    const b = run(small(), d, snap({ namesByEnv: new Map([["env-def", { apps: new Map([["web2", "x"]]), dbs: new Map() }]]) })).res.mappingHash;
    expect(a).toBe(b);
  });
  it("docHash / isEmptyDoc", () => {
    expect(isEmptyDoc(doc())).toBe(true);
    expect(isEmptyDoc(doc({ items: { [APP1]: { include: true } } }))).toBe(true);
    expect(isEmptyDoc(doc({ items: { [APP1]: { name: "x" } } }))).toBe(false);
    expect(docHash(doc({ items: { [APP1]: { name: "x" } } }))).not.toBe(docHash(doc()));
  });
});

describe("the owner's scrubbed fleet (78 apps / 29 databases)", () => {
  it("77 apps and 28 DBs map while the big DB is excluded; resolves quickly; same-name apps need the ack", () => {
    const f = ownerFleet();
    const plan = planImport(f, { sourceKind: "coolify" });
    expect(plan.totals).toMatchObject({ apps: 78, databases: 29 });
    const items: ImportMappingDoc["items"] = {};
    for (const a of f.apps) items[`app:srv-1:${a.sourceRef}`] = { name: `prod-${a.name}-${a.sourceRef}` };
    items[BIG_DB_REF] = { include: false };
    items["app:srv-1:app-78"] = { include: false };
    const t0 = Date.now();
    const res = resolveMapping(f, plan, doc({ items }), snap(), opts(plan));
    expect(Date.now() - t0).toBeLessThan(50);
    expect(res.counts.excluded).toBe(2);
    expect(res.counts.renamed).toBe(77);
    expect(res.effective.filter((e) => e.status === "pending")).toHaveLength(77 + 28);
    expect(res.effective.find((e) => e.itemRef === BIG_DB_REF)!.status).toBe("excluded");
    expect(unackedConflicts(res)).toEqual([]); // renaming made the three "api" apps unique
    // without the rename the three same-named "api" apps collide in the one Coolify namespace
    const plain = resolveMapping(f, plan, doc(), snap(), opts(plan));
    expect(plain.conflicts.filter((c) => c.code === "name.duplicate")).toHaveLength(3);
    // ... but moved into different (project, environment) pairs they pass with no ack
    const split = resolveMapping(f, plan, doc({ items: { "app:srv-1:app-03": { project: "A" }, "app:srv-1:app-31": { project: "B" } } }), snap(), opts(plan));
    expect(split.conflicts.filter((c) => c.code === "name.duplicate")).toHaveLength(0); // 62 stays alone in the default env
  });
  it("eight scope labels give eight independent hashes for the same doc", () => {
    const f = ownerFleet();
    const plan = planImport(f, { sourceKind: "coolify" });
    const hashes = new Set<string>();
    for (let i = 1; i <= 8; i++) hashes.add(resolveMapping(f, plan, doc({ acks: [`s${i}`] }), snap(), opts(plan)).mappingHash);
    expect(hashes.size).toBe(8);
  });
});

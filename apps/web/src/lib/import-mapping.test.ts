import { describe, it, expect } from "vitest";
import {
  NAME_MAX,
  validateName,
  checkAlias,
  isValidDbIdentifier,
  emptyDoc,
  buildTemplate,
  setItemField,
  resetItem,
  resetAll,
  setAck,
  removeOrphans,
  applyBulk,
  moveRows,
  diffDoc,
  mappingReducer,
  initMappingState,
  mappingFileName,
  serializeMapping,
  parseMappingFile,
  scopeMismatch,
  canApply,
  reviewCounts,
  groupRows,
  dropProject,
  errorsOf,
  unackedOf,
} from "./import-mapping";
import type { ImportPlan, ImportResolved, ImportEffectiveItem } from "./types";

/** The shared name-policy vector table — mirrors NAME_VECTORS in apps/hub-api/src/importer/import-mapping.spec.ts literally. */
const NAME_VECTORS: Array<{ kind: keyof typeof NAME_MAX; input: string; ok: boolean; value?: string; code?: string }> = [
  { kind: "app", input: "  web  ", ok: true, value: "web" },
  { kind: "app", input: "", ok: false, code: "name.invalid" },
  { kind: "app", input: "   ", ok: false, code: "name.invalid" },
  { kind: "app", input: "café", ok: true, value: "café" },
  { kind: "app", input: "a".repeat(100), ok: true, value: "a".repeat(100) },
  { kind: "app", input: "a".repeat(101), ok: false, code: "name.too_long" },
  { kind: "database", input: "d".repeat(60), ok: true, value: "d".repeat(60) },
  { kind: "database", input: "d".repeat(61), ok: false, code: "name.too_long" },
  { kind: "project", input: "p".repeat(80), ok: true, value: "p".repeat(80) },
  { kind: "project", input: "p".repeat(81), ok: false, code: "name.too_long" },
  { kind: "environment", input: "e".repeat(81), ok: false, code: "name.too_long" },
  { kind: "gitsource", input: "g".repeat(81), ok: false, code: "name.too_long" },
  { kind: "database", input: "\u{1F600}".repeat(60), ok: true, value: "\u{1F600}".repeat(60) },
  { kind: "database", input: "\u{1F600}".repeat(61), ok: false, code: "name.too_long" },
  { kind: "project", input: "\u{1F600}".repeat(40), ok: true, value: "\u{1F600}".repeat(40) },
  { kind: "project", input: "\u{1F600}".repeat(41), ok: false, code: "name.too_long" },
  { kind: "app", input: "a‮b", ok: false, code: "name.invalid" },
  { kind: "app", input: "a⁦b", ok: false, code: "name.invalid" },
  { kind: "app", input: "a​b", ok: false, code: "name.invalid" },
  { kind: "app", input: "a‍b", ok: false, code: "name.invalid" },
  { kind: "app", input: "a⁠b", ok: false, code: "name.invalid" },
  { kind: "app", input: "a﻿b", ok: false, code: "name.invalid" },
  { kind: "app", input: "a\u0000b", ok: false, code: "name.invalid" },
  { kind: "app", input: "a\tb", ok: false, code: "name.invalid" },
  { kind: "app", input: "a\nb", ok: false, code: "name.invalid" },
];

const plan: ImportPlan = {
  sourceKind: "coolify",
  mode: "copy",
  planHash: "a".repeat(32),
  warnings: [],
  totals: { apps: 2, databases: 1, volumes: 1, blockers: 0 },
  items: [
    { itemRef: "app:s:a1", kind: "app", name: "web", proposed: {}, risks: [], dependsOn: [] },
    { itemRef: "app:s:a2", kind: "app", name: "worker", proposed: {}, risks: [], dependsOn: [] },
    { itemRef: "database:s:d1", kind: "database", name: "orders", proposed: {}, risks: [], dependsOn: [] },
    { itemRef: "volume:s:v1", kind: "volume", name: "vol", proposed: {}, risks: [], dependsOn: [] },
  ],
};

describe("validateName (shared parity table)", () => {
  it.each(NAME_VECTORS)("$kind %j", (v) => {
    const r = validateName(v.kind, v.input);
    if (v.ok) expect(r).toEqual({ ok: true, value: v.value });
    else expect(r).toEqual({ ok: false, code: v.code });
  });
});

describe("alias / identifier checks", () => {
  it("mirrors the hub rules", () => {
    expect(checkAlias("web-api")).toBe("ok");
    expect(checkAlias("Web")).toBe("alias.invalid");
    expect(checkAlias("-x")).toBe("alias.invalid");
    expect(checkAlias("a".repeat(64))).toBe("alias.invalid");
    expect(checkAlias("tugra-x")).toBe("alias.reserved");
    expect(checkAlias("tugra_x")).toBe("alias.invalid"); // underscore is not a DNS label char
    expect(checkAlias("tugra")).toBe("ok");
    expect(isValidDbIdentifier("ledger_2")).toBe(true);
    expect(isValidDbIdentifier("Ledger")).toBe(false);
    expect(isValidDbIdentifier("1x")).toBe(false);
  });
});

describe("document edits", () => {
  it("buildTemplate is an identity mapping of every app/database (never volumes)", () => {
    const t = buildTemplate(plan, { sourceKind: "coolify", scopeKey: "team-3" });
    expect(Object.keys(t.items)).toEqual(["app:s:a1", "app:s:a2", "database:s:d1"]);
    expect(t.items["app:s:a1"]).toEqual({ include: true, name: "web" });
    expect(t.scope).toEqual({ sourceKind: "coolify", scopeKey: "team-3" });
  });
  it("setItemField stores a change and prunes a value equal to the source default", () => {
    let d = emptyDoc();
    d = setItemField(d, "app:s:a1", "name", "Storefront", "web");
    expect(d.items["app:s:a1"]).toEqual({ name: "Storefront" });
    d = setItemField(d, "app:s:a1", "project", "Shop", "web");
    d = setItemField(d, "app:s:a1", "name", "web", "web"); // back to the source name
    expect(d.items["app:s:a1"]).toEqual({ project: "Shop" });
    d = setItemField(d, "app:s:a1", "project", "", "web");
    expect(d.items).toEqual({});
    d = setItemField(d, "app:s:a2", "include", false, "worker");
    expect(d.items["app:s:a2"]).toEqual({ include: false });
    d = setItemField(d, "app:s:a2", "include", true, "worker");
    expect(d.items).toEqual({});
  });
  it("edits are pure (the input doc is never mutated)", () => {
    const d = emptyDoc();
    const snap = JSON.stringify(d);
    setItemField(d, "app:s:a1", "name", "x", "web");
    expect(JSON.stringify(d)).toBe(snap);
  });
  it("reset item / reset all / acks / orphans", () => {
    let d = setItemField(emptyDoc({ sourceKind: "coolify" }), "app:s:a1", "name", "x", "web");
    d = setAck(setAck(d, "k1", true), "k1", true);
    expect(d.acks).toEqual(["k1"]);
    expect(setAck(d, "k1", false).acks).toEqual([]);
    expect(resetItem(d, "app:s:a1").items).toEqual({});
    const all = resetAll(d);
    expect(all.items).toEqual({});
    expect(all.acks).toEqual([]);
    expect(all.scope).toEqual({ sourceKind: "coolify" });
    expect(removeOrphans(d, ["app:s:a1"]).items).toEqual({});
  });
});

describe("bulk operations expand into explicit per-item rows", () => {
  const rows = [
    { itemRef: "app:s:a1", sourceName: "web", name: "web", environment: null },
    { itemRef: "app:s:a2", sourceName: "worker", name: "worker", environment: null },
  ];
  it("prefix / suffix / replace / lowercase", () => {
    expect(applyBulk(emptyDoc(), rows, { type: "prefix", text: "prod-" }).items).toEqual({ "app:s:a1": { name: "prod-web" }, "app:s:a2": { name: "prod-worker" } });
    expect(applyBulk(emptyDoc(), rows, { type: "suffix", text: "-v2" }).items["app:s:a1"]).toEqual({ name: "web-v2" });
    expect(applyBulk(emptyDoc(), rows, { type: "replace", find: "or", with: "OR" }).items).toEqual({ "app:s:a2": { name: "wORker" } }); // unchanged rows stay implicit
    expect(applyBulk(emptyDoc(), rows, { type: "replace", find: "", with: "x" }).items).toEqual({}); // empty find is a no-op
    expect(applyBulk(emptyDoc(), [{ itemRef: "app:s:a9", sourceName: "Web", name: "Web", environment: null }], { type: "lowercase" }).items["app:s:a9"]).toEqual({ name: "web" });
    expect(applyBulk(emptyDoc(), [{ ...rows[0], name: "WeB" }], { type: "lowercase" }).items).toEqual({}); // lands back on the source name -> implicit
  });
  it("stacking bulk actions composes on the CURRENT name", () => {
    const d1 = applyBulk(emptyDoc(), rows, { type: "prefix", text: "prod-" });
    const cur = rows.map((r) => ({ ...r, name: d1.items[r.itemRef]?.name ?? r.name }));
    const d2 = applyBulk(d1, cur, { type: "suffix", text: "-eu" });
    expect(d2.items["app:s:a1"]).toEqual({ name: "prod-web-eu" });
  });
  it("move writes project AND environment explicitly; exclude/include/reset", () => {
    const d = applyBulk(emptyDoc(), rows, { type: "move", project: " Shop ", environment: "live" });
    expect(d.items["app:s:a1"]).toEqual({ project: "Shop", environment: "live" });
    const noEnv = applyBulk(emptyDoc(), rows, { type: "move", project: "Shop", environment: "" });
    expect(noEnv.items["app:s:a1"]).toEqual({ project: "Shop" });
    const ex = applyBulk(emptyDoc(), rows, { type: "exclude" });
    expect(ex.items["app:s:a2"]).toEqual({ include: false });
    expect(applyBulk(ex, rows, { type: "include" }).items).toEqual({});
    expect(applyBulk(ex, rows, { type: "reset" }).items).toEqual({});
  });
  it("moveRows keeps each row's environment explicit", () => {
    const d = moveRows(emptyDoc(), [{ ...rows[0], environment: "staging" }, rows[1]], "Ops");
    expect(d.items["app:s:a1"]).toEqual({ project: "Ops", environment: "staging" });
    expect(d.items["app:s:a2"]).toEqual({ project: "Ops" });
  });
});

describe("history", () => {
  it("edit pushes, undo pops, identical doc is a no-op, history is capped", () => {
    let s = initMappingState(emptyDoc());
    const d1 = setItemField(s.doc, "app:s:a1", "name", "x", "web");
    s = mappingReducer(s, { type: "edit", doc: d1 });
    expect(s.past).toHaveLength(1);
    expect(mappingReducer(s, { type: "edit", doc: s.doc })).toBe(s);
    s = mappingReducer(s, { type: "undo" });
    expect(s.doc.items).toEqual({});
    expect(mappingReducer(s, { type: "undo" })).toBe(s);
    for (let i = 0; i < 80; i++) s = mappingReducer(s, { type: "edit", doc: setItemField(s.doc, "app:s:a1", "name", `n${i}`, "web") });
    expect(s.past.length).toBe(50);
  });
});

describe("download / upload", () => {
  it("round-trips identically and names the file by scope", () => {
    const d = setItemField(buildTemplate(plan, { sourceKind: "coolify", scopeKey: "team-3" }), "app:s:a1", "name", "Storefront", "web");
    const parsed = parseMappingFile(serializeMapping(d));
    expect(parsed).toEqual({ ok: true, doc: d });
    expect(mappingFileName("team-3", "coolify")).toBe("tugra-import-mapping-team-3.json");
    expect(mappingFileName(undefined, "dokploy")).toBe("tugra-import-mapping-dokploy.json");
  });
  it("rejects non-JSON and non-mapping files; defaults missing collections", () => {
    expect(parseMappingFile("{nope")).toEqual({ ok: false, error: "json" });
    expect(parseMappingFile("[]")).toEqual({ ok: false, error: "shape" });
    expect(parseMappingFile('{"version":2}')).toEqual({ ok: false, error: "shape" });
    expect(parseMappingFile('{"version":1,"items":[]}')).toEqual({ ok: false, error: "shape" });
    expect(parseMappingFile('{"version":1}')).toEqual({ ok: true, doc: { version: 1, items: {}, projects: {}, gitSources: {}, acks: [] } });
  });
  it("keeps unknown keys so the hub's strict schema can report them", () => {
    const r = parseMappingFile('{"version":1,"rules":[1]}');
    expect(r.ok && (r.doc as unknown as Record<string, unknown>).rules).toEqual([1]);
  });
  it("scopeMismatch: another source kind or another scope label", () => {
    const base = emptyDoc();
    expect(scopeMismatch(base, "coolify", "team-3")).toBe(false);
    expect(scopeMismatch({ ...base, scope: { sourceKind: "coolify", scopeKey: "team-3" } }, "coolify", "team-3")).toBe(false);
    expect(scopeMismatch({ ...base, scope: { sourceKind: "coolify", scopeKey: "team-3" } }, "coolify", "team-5")).toBe(true);
    expect(scopeMismatch({ ...base, scope: { sourceKind: "dokploy" } }, "coolify", "")).toBe(true);
    expect(scopeMismatch({ ...base, scope: { sourceKind: "coolify" } }, "coolify", "team-5")).toBe(false);
  });
  it("diffDoc lists per-field changes in a stable order", () => {
    const a = setItemField(emptyDoc(), "app:s:a1", "name", "x", "web");
    const b = setItemField(setItemField(emptyDoc(), "app:s:a1", "name", "y", "web"), "app:s:a2", "include", false, "worker");
    expect(diffDoc(a, b)).toEqual([
      { itemRef: "app:s:a1", field: "name", from: "x", to: "y" },
      { itemRef: "app:s:a2", field: "include", from: undefined, to: false },
    ]);
    expect(diffDoc(a, a)).toEqual([]);
  });
});

describe("apply gate", () => {
  const eff = (over: Partial<ImportEffectiveItem> = {}): ImportEffectiveItem => ({ itemRef: "app:s:a1", kind: "app", sourceName: "web", include: true, name: "web", project: null, environment: null, origin: { name: "source", placement: "default" }, status: "pending", changed: [], ...over });
  const res = (over: Partial<ImportResolved> = {}): ImportResolved => ({ version: 1, effective: [eff()], projects: [], gitSources: [], conflicts: [], orphans: [], mappingHash: "m".repeat(32), counts: { renamed: 0, moved: 0, excluded: 0, aliased: 0, newProjects: 0, newEnvironments: 0 }, ...over });
  const gate = (resolved: ImportResolved | null, over = {}) => ({ fresh: true, inFlight: false, hasTarget: true, resolved, ...over });
  it("enabled only on a fresh, error-free, fully-acknowledged resolve with something to import", () => {
    expect(canApply(gate(res()))).toBe(true);
    expect(canApply(gate(res(), { fresh: false }))).toBe(false); // stale hash
    expect(canApply(gate(res(), { inFlight: true }))).toBe(false);
    expect(canApply(gate(res(), { hasTarget: false }))).toBe(false);
    expect(canApply(gate(null))).toBe(false);
    expect(canApply(gate(res({ conflicts: [{ code: "name.invalid", level: "error", params: {} }] })))).toBe(false);
    const ackable = { code: "name.duplicate", level: "warn" as const, params: {}, requiresAck: true, ackKey: "k", acked: false };
    expect(canApply(gate(res({ conflicts: [ackable] })))).toBe(false);
    expect(canApply(gate(res({ conflicts: [{ ...ackable, acked: true }] })))).toBe(true);
    expect(canApply(gate(res({ orphans: ["app:s:gone"] })))).toBe(false);
    expect(canApply(gate(res({ effective: [eff({ status: "excluded" })] })))).toBe(false); // nothing left to import
    expect(canApply(gate(res({ effective: [eff({ status: "already_imported", drift: ["name"] })] })))).toBe(true);
    expect(canApply(gate(res({ effective: [eff({ status: "already_imported" })] })))).toBe(false);
  });
  it("counts and filters", () => {
    const r = res({ effective: [eff(), eff({ itemRef: "database:s:d1", kind: "database", status: "pending" }), eff({ itemRef: "app:s:a2", status: "excluded" })], counts: { renamed: 2, moved: 1, excluded: 1, aliased: 0, newProjects: 1, newEnvironments: 2 }, conflicts: [{ code: "a", level: "error", params: {} }, { code: "b", level: "warn", params: {} }, { code: "c", level: "warn", params: {}, requiresAck: true, acked: false }] });
    expect(reviewCounts(r)).toMatchObject({ apps: 1, databases: 1, excluded: 1, renamed: 2, moved: 1, errors: 1, warnings: 2, newProjects: 1, newEnvironments: 2 });
    expect(errorsOf(r)).toHaveLength(1);
    expect(unackedOf(r)).toHaveLength(1);
    expect(reviewCounts(null)).toMatchObject({ apps: 0, errors: 0 });
  });
  it("groupRows keeps order and buckets a null project as Ungrouped (empty key)", () => {
    expect(groupRows([{ project: "B" }, { project: null }, { project: "B" }, { project: "A" }]).map((g) => [g.project, g.rows.length])).toEqual([["B", 2], ["", 1], ["A", 1]]);
  });
});

describe("dropProject (drag an item onto a group)", () => {
  it("re-targets to the group's project", () => {
    expect(dropProject("Shop", "Blog")).toBe("Blog");
    expect(dropProject(null, "Blog")).toBe("Blog");
  });
  it("does nothing on its own group or on the Ungrouped bucket", () => {
    expect(dropProject("Blog", "Blog")).toBeNull();
    expect(dropProject("Blog", "")).toBeNull();
  });
});

import type { ImportConflict, ImportMappingDoc, ImportMappingItem, ImportPlan, ImportPlanItem, ImportRemoteKind, ImportResolved } from "./types";

// Pure helpers for the import "Review & rename" step: the advisory validators (the hub is authoritative), the
// mapping document operations (every bulk action expands into explicit per-item rows — WYSIWYG, no rules), a small
// undo history, the download/upload file codec and the apply gate. No React, no network.

// ── advisory name policy (mirrors the hub's validateName; parity pinned by an identical vector table) ──

/** Per-kind caps in code points. Projects/environments are additionally capped in UTF-16 units (the hub's project
 *  service slices by unit). */
export const NAME_MAX = { app: 100, database: 60, project: 80, environment: 80, gitsource: 80 } as const;
export type NameKind = keyof typeof NAME_MAX;
export type NameCheck = { ok: true; value: string } | { ok: false; code: "name.invalid" | "name.too_long" };

// Control characters, bidi embedding/override/isolate marks, zero-width characters.
const FORBIDDEN = /[\p{Cc}‪-‮⁦-⁩​-‍⁠﻿]/u;

/** NFC + trim, then REJECT (never truncate) an empty name, a forbidden character, or one over the cap. */
export function validateName(kind: NameKind, raw: string): NameCheck {
  const value = raw.normalize("NFC").trim();
  if (!value) return { ok: false, code: "name.invalid" };
  if (FORBIDDEN.test(value)) return { ok: false, code: "name.invalid" };
  if ([...value].length > NAME_MAX[kind]) return { ok: false, code: "name.too_long" };
  if ((kind === "project" || kind === "environment") && value.length > NAME_MAX[kind]) return { ok: false, code: "name.too_long" };
  return { ok: true, value };
}

const ALIAS_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_ALIAS_RE = /^tugra[-_]/i;
const DB_IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
export type AliasCheck = "ok" | "alias.invalid" | "alias.reserved";
export function checkAlias(raw: string): AliasCheck {
  if (!ALIAS_RE.test(raw)) return "alias.invalid";
  if (RESERVED_ALIAS_RE.test(raw)) return "alias.reserved";
  return "ok";
}
export const isValidDbIdentifier = (s: string): boolean => DB_IDENT_RE.test(s);

// ── the document ────────────────────────────────────────────────────────────────────────────────────

export const emptyDoc = (scope?: ImportMappingDoc["scope"]): ImportMappingDoc => ({ version: 1, ...(scope ? { scope } : {}), items: {}, projects: {}, gitSources: {}, acks: [] });

/** The app/database items of a plan (volumes are never mapped). */
export const mappableItems = (plan: ImportPlan): ImportPlanItem[] => plan.items.filter((i) => i.kind === "app" || i.kind === "database");

/** An identity mapping: every app/database present with its source name (what the download is pre-filled with). */
export function buildTemplate(plan: ImportPlan, scope?: ImportMappingDoc["scope"]): ImportMappingDoc {
  const items: ImportMappingDoc["items"] = {};
  for (const it of mappableItems(plan)) items[it.itemRef] = { include: true, name: it.name };
  return { ...emptyDoc(scope), items };
}

export type ItemField = "include" | "name" | "project" | "environment" | "containerAlias" | "dbIdentifier";

const isDefault = (field: ItemField, value: unknown, sourceName: string): boolean => {
  if (field === "include") return value !== false;
  if (field === "name") return value === sourceName;
  if (field === "containerAlias") return value === undefined;
  return value === undefined || value === "";
};

/** Set (or, when it equals the source default, clear) one field of one item. Pure: returns a new doc. */
export function setItemField(doc: ImportMappingDoc, ref: string, field: ItemField, value: string | boolean | null | undefined, sourceName: string): ImportMappingDoc {
  const cur: ImportMappingItem = { ...(doc.items[ref] ?? {}) };
  const rec = cur as Record<string, unknown>;
  if (isDefault(field, value, sourceName)) delete rec[field];
  else rec[field] = value;
  const items = { ...doc.items };
  if (Object.keys(cur).length) items[ref] = cur;
  else delete items[ref];
  return { ...doc, items };
}

export const resetItem = (doc: ImportMappingDoc, ref: string): ImportMappingDoc => {
  const items = { ...doc.items };
  delete items[ref];
  return { ...doc, items };
};
/** Reset every item and the acks, keeping the scope. */
export const resetAll = (doc: ImportMappingDoc): ImportMappingDoc => ({ ...emptyDoc(doc.scope), gitSources: doc.gitSources, projects: doc.projects });

export const setAck = (doc: ImportMappingDoc, key: string, on: boolean): ImportMappingDoc => ({
  ...doc,
  acks: on ? (doc.acks.includes(key) ? doc.acks : [...doc.acks, key]) : doc.acks.filter((k) => k !== key),
});

export function removeOrphans(doc: ImportMappingDoc, refs: string[]): ImportMappingDoc {
  const drop = new Set(refs);
  return { ...doc, items: Object.fromEntries(Object.entries(doc.items).filter(([k]) => !drop.has(k))) };
}

export type BulkOp =
  | { type: "prefix"; text: string }
  | { type: "suffix"; text: string }
  | { type: "replace"; find: string; with: string }
  | { type: "lowercase" }
  | { type: "move"; project: string; environment: string }
  | { type: "exclude" }
  | { type: "include" }
  | { type: "reset" };

/** What the bulk action sees of one row: its source name and its CURRENT effective name/placement. */
export interface BulkRow {
  itemRef: string;
  sourceName: string;
  name: string;
  environment: string | null;
}

/**
 * Expand a bulk action over `rows` into explicit per-item edits (nothing is stored as a rule). A `move` writes
 * BOTH project and environment explicitly (a project alone would reset the environment to "production"). An empty
 * `find` leaves a `replace` as a no-op.
 */
export function applyBulk(doc: ImportMappingDoc, rows: BulkRow[], op: BulkOp): ImportMappingDoc {
  let next = doc;
  for (const r of rows) {
    switch (op.type) {
      case "prefix":
        next = setItemField(next, r.itemRef, "name", op.text + r.name, r.sourceName);
        break;
      case "suffix":
        next = setItemField(next, r.itemRef, "name", r.name + op.text, r.sourceName);
        break;
      case "replace":
        if (op.find) next = setItemField(next, r.itemRef, "name", r.name.split(op.find).join(op.with), r.sourceName);
        break;
      case "lowercase":
        next = setItemField(next, r.itemRef, "name", r.name.toLowerCase(), r.sourceName);
        break;
      case "move":
        next = setItemField(next, r.itemRef, "project", op.project.trim(), r.sourceName);
        next = setItemField(next, r.itemRef, "environment", op.environment.trim() || undefined, r.sourceName);
        break;
      case "exclude":
        next = setItemField(next, r.itemRef, "include", false, r.sourceName);
        break;
      case "include":
        next = setItemField(next, r.itemRef, "include", true, r.sourceName);
        break;
      case "reset":
        next = resetItem(next, r.itemRef);
        break;
    }
  }
  return next;
}

/** Re-target a group's rows to one project, keeping each row's current environment explicit (a project alone would
 *  reset the environment to "production"). Rows with no environment get only the project. */
export function moveRows(doc: ImportMappingDoc, rows: BulkRow[], project: string): ImportMappingDoc {
  let next = doc;
  for (const r of rows) {
    next = setItemField(next, r.itemRef, "project", project.trim(), r.sourceName);
    if (r.environment) next = setItemField(next, r.itemRef, "environment", r.environment, r.sourceName);
  }
  return next;
}

// ── diff (upload preview) ───────────────────────────────────────────────────────────────────────────

export interface DocChange {
  itemRef: string;
  field: ItemField;
  from: string | boolean | null | undefined;
  to: string | boolean | null | undefined;
}
const FIELDS: ItemField[] = ["include", "name", "project", "environment", "containerAlias", "dbIdentifier"];
/** Per-field differences between two documents (for the upload preview). Sorted for a stable display. */
export function diffDoc(a: ImportMappingDoc, b: ImportMappingDoc): DocChange[] {
  const out: DocChange[] = [];
  for (const ref of [...new Set([...Object.keys(a.items), ...Object.keys(b.items)])].sort()) {
    for (const f of FIELDS) {
      const from = (a.items[ref] as Record<string, unknown> | undefined)?.[f] as DocChange["from"];
      const to = (b.items[ref] as Record<string, unknown> | undefined)?.[f] as DocChange["to"];
      if (from !== to) out.push({ itemRef: ref, field: f, from, to });
    }
  }
  return out;
}

// ── undo history ────────────────────────────────────────────────────────────────────────────────────

export interface MappingState {
  doc: ImportMappingDoc;
  past: ImportMappingDoc[];
}
export type MappingAction = { type: "edit"; doc: ImportMappingDoc } | { type: "undo" };
const HISTORY = 50;
export function mappingReducer(state: MappingState, action: MappingAction): MappingState {
  if (action.type === "undo") {
    if (!state.past.length) return state;
    return { doc: state.past[state.past.length - 1], past: state.past.slice(0, -1) };
  }
  if (action.doc === state.doc) return state;
  return { doc: action.doc, past: [...state.past, state.doc].slice(-HISTORY) };
}
export const initMappingState = (doc: ImportMappingDoc): MappingState => ({ doc, past: [] });

// ── file codec ──────────────────────────────────────────────────────────────────────────────────────

export const mappingFileName = (scopeKey: string | undefined, source: ImportRemoteKind): string => `tugra-import-mapping-${scopeKey || source}.json`;
export const serializeMapping = (doc: ImportMappingDoc): string => JSON.stringify(doc, null, 2) + "\n";

export type ParsedMapping = { ok: true; doc: ImportMappingDoc } | { ok: false; error: "json" | "shape" };
/** Parse an uploaded mapping file. Shallow (the hub's strict schema is authoritative and its 400 reason is shown). */
export function parseMappingFile(text: string): ParsedMapping {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "json" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "shape" };
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return { ok: false, error: "shape" };
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if ((o.items !== undefined && !obj(o.items)) || (o.projects !== undefined && !obj(o.projects)) || (o.gitSources !== undefined && !obj(o.gitSources)) || (o.acks !== undefined && !Array.isArray(o.acks))) return { ok: false, error: "shape" };
  return { ok: true, doc: { ...(o as unknown as ImportMappingDoc), items: (o.items ?? {}) as ImportMappingDoc["items"], projects: (o.projects ?? {}) as ImportMappingDoc["projects"], gitSources: (o.gitSources ?? {}) as ImportMappingDoc["gitSources"], acks: (o.acks ?? []) as string[] } };
}

/** True when an uploaded file's scope names another source team/token than this session's. */
export function scopeMismatch(doc: ImportMappingDoc, kind: ImportRemoteKind, scopeKey: string): boolean {
  if (!doc.scope) return false;
  return doc.scope.sourceKind !== kind || (doc.scope.scopeKey !== undefined && doc.scope.scopeKey !== scopeKey);
}

// ── conflicts / gate ────────────────────────────────────────────────────────────────────────────────

export const conflictsFor = (r: ImportResolved | null, itemRef: string): ImportConflict[] => (r?.conflicts ?? []).filter((c) => c.itemRef === itemRef);
export const errorsOf = (r: ImportResolved | null): ImportConflict[] => (r?.conflicts ?? []).filter((c) => c.level === "error");
export const unackedOf = (r: ImportResolved | null): ImportConflict[] => (r?.conflicts ?? []).filter((c) => c.requiresAck && !c.acked);

export interface ApplyGate {
  /** the latest resolve is for exactly the current document + target (not stale, not in flight) */
  fresh: boolean;
  inFlight: boolean;
  hasTarget: boolean;
  resolved: ImportResolved | null;
}
/** Apply is enabled only on a fresh, error-free, fully-acknowledged resolve with something to import. */
export function canApply(g: ApplyGate): boolean {
  if (!g.hasTarget || g.inFlight || !g.fresh || !g.resolved) return false;
  if (errorsOf(g.resolved).length || unackedOf(g.resolved).length || g.resolved.orphans.length) return false;
  return g.resolved.effective.some((e) => e.status === "pending" || (e.status === "already_imported" && !!e.drift?.length));
}

/** Counts shown in the header / apply label. */
export function reviewCounts(r: ImportResolved | null) {
  const eff = r?.effective ?? [];
  return {
    apps: eff.filter((e) => e.kind === "app" && e.status === "pending").length,
    databases: eff.filter((e) => e.kind === "database" && e.status === "pending").length,
    excluded: r?.counts.excluded ?? 0,
    renamed: r?.counts.renamed ?? 0,
    moved: r?.counts.moved ?? 0,
    aliased: r?.counts.aliased ?? 0,
    errors: errorsOf(r).length,
    warnings: (r?.conflicts ?? []).filter((c) => c.level === "warn").length,
    newProjects: r?.counts.newProjects ?? 0,
    newEnvironments: r?.counts.newEnvironments ?? 0,
  };
}

/** Group effective rows by their target project ("" = no project: the Ungrouped bucket), preserving order. */
export function groupRows<T extends { project: string | null }>(rows: T[]): Array<{ project: string; rows: T[] }> {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.project ?? "", [...(m.get(r.project ?? "") ?? []), r]);
  return [...m.entries()].map(([project, rs]) => ({ project, rows: rs }));
}

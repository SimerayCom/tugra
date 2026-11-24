import type { ImportMappingDoc, ImportPlan, ImportPlanItem, ImportServiceChoice } from "./types";
import { UNKNOWN_SOURCE_HOST, sourceServersOf, type SourceServerRow } from "./migration-run";
import { setItemField } from "./import-mapping";

// Pure helpers for the import's first step, "What are you moving?": pick a source server, one or more source projects, or
// everything; the plan's items are then in or out of scope, each involved source server gets a Tugra server, and the
// result feeds the later steps as names-only data (mapping excludes, service skips, a serverMap). No React, no network.

export type ScopeMode = "everything" | "servers" | "projects";

export interface ScopeSelection {
  mode: ScopeMode;
  /** Source server refs picked in "servers" mode. */
  hosts: ReadonlySet<string>;
  /** Source project refs picked in "projects" mode. */
  projects: ReadonlySet<string>;
  /** Items pulled in on top of the pick (what a picked item needs, added with one click). */
  extra: ReadonlySet<string>;
  /** Source server ref to Tugra server id, for every source server that has something in scope. */
  placement: Readonly<Record<string, string>>;
}

export const emptySelection = (): ScopeSelection => ({ mode: "everything", hosts: new Set(), projects: new Set(), extra: new Set(), placement: {} });

/** What the scope step hands to the later steps. */
export interface ImportScope {
  selection: ScopeSelection;
  /** The itemRefs that stay in (apps, databases, services and the volumes they carry). */
  inScope: ReadonlySet<string>;
  /** True when something of the plan is left out (a guided run, which has no mapping, would still move all of it). */
  narrowed: boolean;
  /** The default target server (the first involved source server's pick). */
  defaultServerId: string;
  /** Sent as `serverMap` only when the involved source servers land on more than one Tugra server; otherwise undefined. */
  serverMap: Record<string, string> | undefined;
}

/** The source server ref of a plan itemRef (`<kind>:<serverRef|_>:<ref>`); `_` when unknown. */
export function hostOfItemRef(itemRef: string): string {
  const i1 = itemRef.indexOf(":");
  const i2 = i1 < 0 ? -1 : itemRef.indexOf(":", i1 + 1);
  return i1 >= 0 && i2 > i1 ? itemRef.slice(i1 + 1, i2) || UNKNOWN_SOURCE_HOST : UNKNOWN_SOURCE_HOST;
}

const isPlaceable = (it: Pick<ImportPlanItem, "kind">): boolean => it.kind === "app" || it.kind === "database" || it.kind === "service";

export interface SourceProjectRow {
  ref: string;
  name: string;
  apps: number;
  databases: number;
  services: number;
}

/** The source projects of a plan with what each holds (only items that are in the plan). Empty for a source with no tree. */
export function sourceProjectRows(plan: ImportPlan): SourceProjectRow[] {
  const kindOf = new Map(plan.items.map((i) => [i.itemRef, i.kind] as const));
  const out: SourceProjectRow[] = [];
  for (const p of plan.preflight?.projects ?? []) {
    const row: SourceProjectRow = { ref: p.ref, name: p.name, apps: 0, databases: 0, services: 0 };
    for (const r of p.itemRefs) {
      const k = kindOf.get(r);
      if (k === "app") row.apps += 1;
      else if (k === "database") row.databases += 1;
      else if (k === "service") row.services += 1;
    }
    if (row.apps + row.databases + row.services > 0) out.push(row);
  }
  return out;
}

/** The source servers of a plan (name when the source gave one), with what lives on each. */
export const sourceHostRows = (plan: ImportPlan): SourceServerRow[] => sourceServersOf(plan.items, plan.preflight?.hosts);

/** Items that belong to the picked projects (only those the plan lists). */
function projectItemRefs(plan: ImportPlan, picked: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const p of plan.preflight?.projects ?? []) if (picked.has(p.ref)) for (const r of p.itemRefs) out.add(r);
  return out;
}

/** The itemRefs in scope for a selection. "everything" is every item; volumes follow the apps that declare them. */
export function inScopeRefs(plan: ImportPlan, sel: ScopeSelection): Set<string> {
  if (sel.mode === "everything") return new Set(plan.items.map((i) => i.itemRef));
  const base = new Set<string>();
  if (sel.mode === "servers") {
    for (const it of plan.items) if (isPlaceable(it) && sel.hosts.has(hostOfItemRef(it.itemRef))) base.add(it.itemRef);
  } else {
    for (const r of projectItemRefs(plan, sel.projects)) base.add(r);
  }
  for (const r of sel.extra) base.add(r);
  const out = new Set<string>();
  for (const it of plan.items) {
    if (isPlaceable(it)) {
      if (base.has(it.itemRef)) out.add(it.itemRef);
    }
  }
  // a volume rides with the in-scope item that depends on it
  for (const it of plan.items) if (out.has(it.itemRef)) for (const d of it.dependsOn) if (d.startsWith("volume:")) out.add(d);
  return out;
}

/** The source servers that have something in scope, in the plan's order (what the placement rows are for). */
export function involvedHosts(plan: ImportPlan, inScope: ReadonlySet<string>): SourceServerRow[] {
  const used = new Set<string>();
  for (const it of plan.items) if (isPlaceable(it) && inScope.has(it.itemRef)) used.add(hostOfItemRef(it.itemRef));
  return sourceHostRows(plan).filter((r) => used.has(r.ref));
}

export interface MissingDependency {
  itemRef: string;
  name: string;
  /** The in-scope items that need it. */
  neededBy: string[];
}

/** What an in-scope item links to that is NOT in scope (an app and the database it connects to, in another project or on another server). */
export function missingDependencies(plan: ImportPlan, inScope: ReadonlySet<string>): MissingDependency[] {
  const byRef = new Map(plan.items.map((i) => [i.itemRef, i] as const));
  const need = new Map<string, string[]>();
  for (const it of plan.items) {
    if (!inScope.has(it.itemRef) || !isPlaceable(it)) continue;
    for (const d of it.dependsOn) {
      const dep = byRef.get(d);
      if (!dep || !isPlaceable(dep) || inScope.has(d)) continue;
      need.set(d, [...(need.get(d) ?? []), it.name]);
    }
  }
  return [...need.entries()].map(([itemRef, neededBy]) => ({ itemRef, name: byRef.get(itemRef)!.name, neededBy })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The default selection the step opens with: everything, every source server placed on `defaultServerId`. */
export function initialSelection(plan: ImportPlan, defaultServerId: string): ScopeSelection {
  return { ...emptySelection(), placement: Object.fromEntries(sourceHostRows(plan).map((r) => [r.ref, defaultServerId])) };
}

/**
 * Turn a selection into what the later steps need. `placement` is completed for every involved source server (a server the user
 * has not picked a target for falls back to `fallbackServerId`), and a serverMap exists only when more than one Tugra server is used.
 */
export function buildScope(plan: ImportPlan, sel: ScopeSelection, fallbackServerId: string): ImportScope {
  const inScope = inScopeRefs(plan, sel);
  const hosts = involvedHosts(plan, inScope);
  const placed: Record<string, string> = {};
  for (const h of hosts) placed[h.ref] = sel.placement[h.ref] || fallbackServerId;
  const targets = [...new Set(Object.values(placed))];
  const defaultServerId = hosts.length > 0 ? placed[hosts[0].ref] : fallbackServerId;
  return {
    selection: sel,
    inScope,
    narrowed: plan.items.some((i) => isPlaceable(i) && !inScope.has(i.itemRef)),
    defaultServerId,
    serverMap: targets.length > 1 ? placed : undefined,
  };
}

/** Why the selection cannot continue yet, or null: nothing picked, a target missing, or targets in different teams. */
export function scopeIssue(plan: ImportPlan, scope: ImportScope, teamOf: (serverId: string) => string | undefined): "nothing" | "target" | "teams" | null {
  const apps = plan.items.filter((i) => isPlaceable(i) && scope.inScope.has(i.itemRef));
  if (apps.length === 0) return "nothing";
  const hosts = involvedHosts(plan, scope.inScope);
  const ids = hosts.map((h) => scope.selection.placement[h.ref] || scope.defaultServerId);
  if (ids.some((id) => !id)) return "target";
  if (new Set(ids.map((id) => teamOf(id) ?? id)).size > 1) return "teams";
  return null;
}

/** Add the out-of-scope items to a mapping document as excluded; in-scope ones are included (an explicit include clears a stored exclude). */
export function applyScopeToDoc(doc: ImportMappingDoc, plan: ImportPlan, inScope: ReadonlySet<string>): ImportMappingDoc {
  let next = doc;
  for (const it of plan.items) {
    if (it.kind !== "app" && it.kind !== "database") continue;
    next = setItemField(next, it.itemRef, "include", inScope.has(it.itemRef), it.name);
  }
  return next;
}

/** Service stacks that are out of scope are skipped by choice (a service is not in the mapping), merged under what the user chose. */
export function scopeServiceSkips(plan: ImportPlan, inScope: ReadonlySet<string>): Record<string, ImportServiceChoice> {
  const out: Record<string, ImportServiceChoice> = {};
  for (const it of plan.items) if (it.kind === "service" && !inScope.has(it.itemRef)) out[it.itemRef] = { skip: true };
  return out;
}

/** The plan as the later steps show it: only what is in scope (counts, blockers, coverage and the named preflight lists follow).
 *  planHash is kept, because the hub re-plans the whole source and the apply is bound to that hash. */
export function scopedPlan(plan: ImportPlan, inScope: ReadonlySet<string>): ImportPlan {
  if (plan.items.every((i) => inScope.has(i.itemRef))) return plan;
  const items = plan.items.filter((i) => inScope.has(i.itemRef));
  const names = (kind: ImportPlanItem["kind"]) => new Set(items.filter((i) => i.kind === kind).map((i) => i.name));
  const dbNames = names("database");
  const svcNames = names("service");
  const appNames = names("app");
  const pf = plan.preflight;
  const preflight = pf
    ? {
        ...pf,
        databases: pf.databases.filter((d) => dbNames.has(d.name)),
        services: pf.services.filter((s) => svcNames.has(s.name)),
        volumes: pf.volumes?.filter((v) => appNames.has(v.app)),
        sourceHealth: pf.sourceHealth?.filter((h) => inScope.has(h.itemRef)),
        coverage: pf.coverage ? { ...pf.coverage, apps: pf.coverage.apps.filter((a) => inScope.has(a.itemRef)), env: pf.coverage.env ? { apps: pf.coverage.env.apps.filter((a) => inScope.has(a.itemRef)) } : undefined } : undefined,
      }
    : undefined;
  const count = (k: ImportPlanItem["kind"]) => items.filter((i) => i.kind === k).length;
  return {
    ...plan,
    items,
    totals: {
      apps: count("app"),
      databases: count("database"),
      volumes: count("volume"),
      blockers: items.reduce((n, it) => n + it.risks.filter((r) => r.level === "blocker").length, 0),
      ...(plan.totals.services !== undefined ? { services: count("service") } : {}),
    },
    ...(preflight ? { preflight } : {}),
  };
}

/**
 * What the project pickers of the review step offer: the target team's existing projects, then the projects this import will create
 * (the resolve says which) and the source's own project names, which the import creates on the target when it is missing. Marked new
 * when the target team has no such project. One entry per name, compared without case.
 */
export function projectChoicesFor(
  existing: ReadonlyArray<{ name: string }>,
  resolved: ReadonlyArray<{ name: string; willCreate: boolean }> | undefined,
  sourceNames: ReadonlyArray<string>,
): Array<{ name: string; isNew?: boolean }> {
  const out = new Map<string, { name: string; isNew?: boolean }>();
  for (const p of existing) out.set(p.name.toLowerCase(), { name: p.name });
  for (const p of resolved ?? []) if (!out.has(p.name.toLowerCase())) out.set(p.name.toLowerCase(), p.willCreate ? { name: p.name, isNew: true } : { name: p.name });
  for (const n of sourceNames) if (n && !out.has(n.toLowerCase())) out.set(n.toLowerCase(), { name: n, isNew: true });
  return [...out.values()];
}

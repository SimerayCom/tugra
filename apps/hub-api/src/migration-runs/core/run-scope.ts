/**
 * The scope of a guided run, pure. A run moves the whole source unless the create body names a `scope`: which source servers and
 * source projects to move, items to pull in on top, and items to leave out. The hub turns that into what the importer already
 * understands (`include: false` rows of the mapping document, `skip` choices for service stacks), so every later step (PREFLIGHT,
 * IMPORT, the data lane, CUTOVER) sees exactly the chosen items and nothing else. Names only, never a secret.
 */
import type { ImportMappingDoc } from "../../importer/import-mapping";
import type { ServiceChoice } from "../../importer/dto";
import type { RunScope } from "./dto";

/** The slice of a plan the scope needs (the importer's plan response satisfies it). */
export interface ScopePlan {
  items: ReadonlyArray<{ itemRef: string; kind: string; name: string; dependsOn?: readonly string[] }>;
  preflight?: { projects?: ReadonlyArray<{ ref: string; itemRefs: readonly string[] }>; hosts?: ReadonlyArray<{ ref: string }> };
}

/** The source server label of an item the source did not place (the plan's `_`). */
export const UNKNOWN_HOST = "_";

const placeable = (kind: string): boolean => kind === "app" || kind === "database" || kind === "service";

/** `kind:<serverRef|_>:<ref>` -> the server ref (`_` when the ref has none). */
export function hostOfItemRef(itemRef: string): string {
  const i1 = itemRef.indexOf(":");
  const i2 = i1 < 0 ? -1 : itemRef.indexOf(":", i1 + 1);
  return i1 >= 0 && i2 > i1 ? itemRef.slice(i1 + 1, i2) || UNKNOWN_HOST : UNKNOWN_HOST;
}

export type ScopeFailure = "scope-unknown-server" | "scope-unknown-project" | "scope-unknown-item" | "scope-empty";

export interface ResolvedScope {
  /** The itemRefs that stay in (apps, databases, services, and the volumes the kept items carry). */
  inScope: Set<string>;
  /** Counts of what is placeable: kept and left out. */
  kept: number;
  excluded: number;
}

/**
 * Resolve a scope against a plan. A source server, project or item the plan does not know is a failure (never silently ignored: the
 * caller named something that is not there), and so is a scope that keeps nothing. `include` and `exclude` take plan itemRefs of an
 * app, database or service; `exclude` wins over everything else.
 */
export function resolveScope(plan: ScopePlan, scope: RunScope): ResolvedScope | { fail: ScopeFailure } {
  const byRef = new Map(plan.items.map((i) => [i.itemRef, i] as const));
  const hosts = new Set<string>();
  for (const i of plan.items) if (placeable(i.kind)) hosts.add(hostOfItemRef(i.itemRef));
  for (const h of plan.preflight?.hosts ?? []) hosts.add(h.ref);
  const projects = new Map((plan.preflight?.projects ?? []).map((p) => [p.ref, p] as const));

  for (const h of scope.sourceServers ?? []) if (!hosts.has(h)) return { fail: "scope-unknown-server" };
  for (const p of scope.projects ?? []) if (!projects.has(p)) return { fail: "scope-unknown-project" };
  for (const r of [...(scope.include ?? []), ...(scope.exclude ?? [])]) {
    const it = byRef.get(r);
    if (!it || !placeable(it.kind)) return { fail: "scope-unknown-item" };
  }

  const picked = new Set<string>();
  const servers = new Set(scope.sourceServers ?? []);
  if (servers.size) for (const i of plan.items) if (placeable(i.kind) && servers.has(hostOfItemRef(i.itemRef))) picked.add(i.itemRef);
  for (const p of scope.projects ?? []) for (const r of projects.get(p)!.itemRefs) if (byRef.has(r)) picked.add(r);
  for (const r of scope.include ?? []) picked.add(r);
  for (const r of scope.exclude ?? []) picked.delete(r);

  const inScope = new Set<string>();
  for (const i of plan.items) if (placeable(i.kind) && picked.has(i.itemRef)) inScope.add(i.itemRef);
  // a volume rides with the kept item that depends on it
  for (const i of plan.items) if (inScope.has(i.itemRef)) for (const d of i.dependsOn ?? []) if (d.startsWith("volume:")) inScope.add(d);

  const total = plan.items.filter((i) => placeable(i.kind)).length;
  const kept = plan.items.filter((i) => placeable(i.kind) && inScope.has(i.itemRef)).length;
  if (kept === 0) return { fail: "scope-empty" };
  return { inScope, kept, excluded: total - kept };
}

/**
 * The mapping document and service choices a resolved scope stands for: every app and database outside the scope gets
 * `include: false`; a service stack outside it is skipped. Whatever the caller already put in `mapping` / `serviceChoices` stays,
 * except that an in-scope item never stays excluded by a stale row of the caller's own (the scope is the stated intent) and an
 * out-of-scope service keeps only `skip`.
 */
export function applyScope(
  plan: ScopePlan,
  inScope: ReadonlySet<string>,
  base: { mapping?: ImportMappingDoc; serviceChoices?: Record<string, ServiceChoice> },
): { mapping: ImportMappingDoc; serviceChoices: Record<string, ServiceChoice> | undefined } {
  const doc: ImportMappingDoc = base.mapping ?? { version: 1, items: {}, projects: {}, gitSources: {}, acks: [] };
  const items = { ...doc.items };
  const choices: Record<string, ServiceChoice> = { ...(base.serviceChoices ?? {}) };
  for (const it of plan.items) {
    const keep = inScope.has(it.itemRef);
    if (it.kind === "app" || it.kind === "database") {
      if (!keep) items[it.itemRef] = { ...(items[it.itemRef] ?? {}), include: false };
      else if (items[it.itemRef]?.include === false) {
        const { include: _drop, ...rest } = items[it.itemRef]!;
        void _drop;
        if (Object.keys(rest).length) items[it.itemRef] = rest;
        else delete items[it.itemRef];
      }
    } else if (it.kind === "service" && !keep) {
      choices[it.itemRef] = { skip: true };
    }
  }
  return { mapping: { ...doc, items }, serviceChoices: Object.keys(choices).length ? choices : undefined };
}

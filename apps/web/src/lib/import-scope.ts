import type { ImportMappingDoc, ImportPlan, ImportPlanItem, ImportServiceChoice, ImportTugraMatch, MigrationRunScope } from "./types";
import { SERVER_MAP_MAX, UNKNOWN_SOURCE_HOST, sourceServersOf, type SourceServerRow } from "./migration-run";
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
  /** The target team picked when the writable servers belong to several teams (kept so reopening the step restores it). */
  teamId?: string;
  /**
   * "everything" of the picked Coolify team only: the source project refs that "everything" is limited to. Set by the step while a
   * team filter is on (never stored), so the scope, the placement rows and the guided run's payload all cover that team and nothing else.
   */
  everythingOf?: readonly string[];
}

/** A Tugra server the user can write to, as the first step needs it (state included so a dead target is never offered as if it worked). */
export interface ScopeServer {
  id: string;
  name: string;
  teamId: string;
  status?: string;
  capabilities?: string[];
  lastSeenAt?: string | null;
}

export const emptySelection = (): ScopeSelection => ({ mode: "everything", hosts: new Set(), projects: new Set(), extra: new Set(), placement: {} });

/** What the scope step hands to the later steps. */
export interface ImportScope {
  selection: ScopeSelection;
  /** The itemRefs that stay in (apps, databases, services and the volumes they carry). */
  inScope: ReadonlySet<string>;
  /** True when something of the plan is left out (a guided run then carries the scope, see {@link scopePayload}). */
  narrowed: boolean;
  /** The default target server (the first involved source server's target); empty while that server has none. */
  defaultServerId: string;
  /** Sent as `serverMap` only when the involved source servers land on more than one Tugra server; otherwise undefined. */
  serverMap: Record<string, string> | undefined;
  /** Source server ref to its target, for the involved source servers that have one (explicit pick, else a sure match). */
  placed: Readonly<Record<string, string>>;
  /** Per placed source server: "in-place" when the target is the machine it already runs on (proxy swap, data stays), else "other-server"
   *  (data copied, temporary address, DNS cutover). The guided run reads its topology from this. */
  placementKind: Readonly<Record<string, PlacementKind>>;
  /** The placed servers sit in more than one Tugra team (Coolify only): the move is a campaign, one per team. Absent = one team. */
  multiTeam?: boolean;
}

export type PlacementKind = "in-place" | "other-server";

/**
 * What a guided run is told about a narrowed scope: the picked source servers or projects and the items pulled in on top. The hub
 * resolves it against the live plan and leaves everything else out of the run, so what the run moves is exactly this selection.
 * Undefined when the whole source moves. Refs are sorted so the same pick sends the same body.
 */
export function scopePayload(scope: ImportScope | null | undefined): MigrationRunScope | undefined {
  if (!scope?.narrowed) return undefined;
  const sel = scope.selection;
  const sorted = (xs: ReadonlySet<string>): string[] => [...xs].sort();
  const sourceServers = sel.mode === "servers" ? sorted(sel.hosts) : [];
  const picked = sel.mode === "projects" ? sorted(sel.projects) : [];
  // an "everything" selection is never narrowed, unless it is limited to one Coolify team: then that team's projects are the run's scope
  const teamProjects = sel.mode === "everything" && sel.everythingOf?.length ? [...sel.everythingOf].sort() : [];
  const include = sel.mode === "everything" && teamProjects.length === 0 ? [] : sorted(sel.extra);
  if (sourceServers.length + picked.length + teamProjects.length + include.length === 0) return undefined;
  const projects = [...picked, ...teamProjects];
  return { ...(sourceServers.length ? { sourceServers } : {}), ...(projects.length ? { projects } : {}), ...(include.length ? { include } : {}) };
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

/** The Coolify team an item belongs to: its project's team, else the team of the server it runs on. Undefined when the read does not tell. */
export function itemTeamRef(plan: ImportPlan, itemRef: string): string | undefined {
  for (const p of plan.preflight?.projects ?? []) if (p.team && p.itemRefs.includes(itemRef)) return p.team.ref;
  return plan.preflight?.hosts?.find((h) => h.ref === hostOfItemRef(itemRef))?.team?.ref;
}

/** The items of a Coolify team the owner left out of the team mapping ("Nothing of this Coolify team is moved"): never in scope, whatever a list shows. */
export function leftOutItemRefs(plan: ImportPlan): ReadonlySet<string> {
  const map = plan.preflight?.teamMap;
  const out = new Set<string>();
  if (!map) return out;
  for (const it of plan.items) {
    if (!isPlaceable(it)) continue;
    const team = itemTeamRef(plan, it.itemRef);
    if (team && map[team] === null) out.add(it.itemRef);
  }
  return out;
}

/** True when this source server's own Coolify team was left out of the team mapping. */
export const hostLeftOut = (plan: ImportPlan, hostRef: string): boolean => {
  const team = plan.preflight?.hosts?.find((h) => h.ref === hostRef)?.team?.ref;
  return !!team && plan.preflight?.teamMap?.[team] === null;
};

/** The Tugra teams the in-scope items must land in (each item's Coolify team, mapped). Empty without a mapping. */
export function mappedTeamsOf(plan: ImportPlan, inScope: ReadonlySet<string>): string[] {
  const map = plan.preflight?.teamMap;
  if (!map) return [];
  const out = new Set<string>();
  for (const it of plan.items) {
    if (!isPlaceable(it) || !inScope.has(it.itemRef)) continue;
    const team = itemTeamRef(plan, it.itemRef);
    const id = team ? map[team] : undefined;
    if (id) out.add(id);
  }
  return [...out];
}

/** The itemRefs in scope for a selection. "everything" is every item; volumes follow the apps that declare them. A left-out Coolify team's items never are. */
export function inScopeRefs(plan: ImportPlan, sel: ScopeSelection): Set<string> {
  const out = rawInScope(plan, sel);
  const left = leftOutItemRefs(plan);
  if (left.size === 0) return out;
  for (const r of left) out.delete(r);
  // a volume rides with an in-scope item: one only left-out items declared goes with them
  const kept = new Set<string>();
  for (const it of plan.items) if (out.has(it.itemRef)) for (const d of it.dependsOn) if (d.startsWith("volume:")) kept.add(d);
  for (const it of plan.items) if (left.has(it.itemRef)) for (const d of it.dependsOn) if (d.startsWith("volume:") && !kept.has(d)) out.delete(d);
  return out;
}

function rawInScope(plan: ImportPlan, sel: ScopeSelection): Set<string> {
  if (sel.mode === "everything" && !sel.everythingOf?.length) return new Set(plan.items.map((i) => i.itemRef));
  const base = new Set<string>();
  if (sel.mode === "everything") {
    for (const r of projectItemRefs(plan, new Set(sel.everythingOf))) base.add(r);
  } else if (sel.mode === "servers") {
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

/** The Tugra server the hub found to be the same machine as a source server (a verdict, never an address). */
export function hostTugra(plan: ImportPlan, ref: string): ImportTugraMatch | undefined {
  return ref === UNKNOWN_SOURCE_HOST ? plan.preflight?.panel?.tugra : plan.preflight?.hosts?.find((h) => h.ref === ref)?.tugra;
}

/**
 * The Tugra server the owner themselves named as the same machine (the match step's answer, kept on the hub session and carried in the
 * plan). An explicit earlier answer, never a guess: later steps carry it forward instead of asking again.
 */
export function ownerTugra(plan: ImportPlan, ref: string): ImportTugraMatch | undefined {
  const h = plan.preflight?.hosts?.find((x) => x.ref === ref);
  return h?.match?.linkedBy === "user" && h.tugra ? h.tugra : undefined;
}

/** True when the owner answered "this is not the same server" for a source server (so nothing matches it and nothing asks again). */
export function ownerSaidNotSame(plan: ImportPlan, ref: string): boolean {
  const h = plan.preflight?.hosts?.find((x) => x.ref === ref);
  return h?.match?.linkedBy === "user" && !h.tugra;
}

/**
 * True for the box the source's own control plane runs on (Coolify: `is_coolify_host`). A second Coolify row for that same machine (added once as
 * localhost and once by its public address) is matched to the server of the agent that read the plan, and is the control plane box too.
 */
export const isControlPlaneHost = (plan: ImportPlan, ref: string): boolean => {
  const h = plan.preflight?.hosts?.find((x) => x.ref === ref);
  if (!h) return false;
  const panelServer = plan.preflight?.agentRead?.agentServerId;
  // the same rule as the hub's (`hostFactOf`): only a sure or probable match counts as "this machine", an uncertain or user-rejected one does not
  const status = h.match?.status ?? (h.tugra ? (h.tugra.confidence === "certain" ? "certain" : "probable") : "none");
  const matched = (status === "certain" || status === "probable") && !!h.tugra;
  return !!h.controlPlane || (!!panelServer && matched && h.tugra?.serverId === panelServer);
};

/**
 * Why a source server cannot be moved onto the machine it runs on, or null when it can. Only Coolify has a proxy swap, and the box that
 * runs Coolify itself must stay up while its other servers move (stopping its proxy would take every managed server offline).
 */
export function inPlaceBlock(plan: ImportPlan, ref: string): "control-plane" | "unsupported-source" | null {
  if (plan.sourceKind !== "coolify") return "unsupported-source";
  return isControlPlaneHost(plan, ref) ? "control-plane" : null;
}

/**
 * The target a source server gets by itself, or "": a sure match (a public address matched), or the machine the owner confirmed in the
 * match step (their own earlier answer). Either way the same-machine move must be possible for it.
 */
export function autoTargetOf(plan: ImportPlan, ref: string): string {
  const m = hostTugra(plan, ref);
  if (!m || inPlaceBlock(plan, ref)) return "";
  return m.confidence === "certain" || ownerTugra(plan, ref) ? m.serverId : "";
}

/**
 * The Tugra server a source server goes to: the user's pick, else the sure match. Never a guess: no match and no pick means no target.
 * `allowed` (the ids of the chosen team's servers) drops a target outside the team.
 */
export function targetOf(plan: ImportPlan, sel: ScopeSelection, ref: string, allowed?: ReadonlySet<string>): string {
  const pick = sel.placement[ref];
  if (pick && (!allowed || allowed.has(pick))) return pick;
  const auto = autoTargetOf(plan, ref);
  return auto && (!allowed || allowed.has(auto)) ? auto : "";
}

export function placementKindOf(plan: ImportPlan, ref: string, targetId: string): PlacementKind {
  const m = hostTugra(plan, ref);
  return m && m.serverId === targetId && !inPlaceBlock(plan, ref) ? "in-place" : "other-server";
}

export type ServerReadiness = "ready" | "pending" | "offline" | "no-deploy";

/** Can this Tugra server take apps now? Its agent must be connected (not waiting, not offline) and have the deploy grant. */
export function serverReadiness(s: Pick<ScopeServer, "status" | "capabilities"> | undefined): ServerReadiness {
  if (!s) return "ready";
  if (s.status === "PENDING") return "pending";
  if (s.status !== undefined && s.status !== "ONLINE") return "offline";
  if (s.capabilities !== undefined && !s.capabilities.includes("deploy")) return "no-deploy";
  return "ready";
}

/** The team the step starts on, or "" when the user has to pick: the team that owns most of the matched servers, else the team named like
 *  the source team, else the only team there is. Never the first team of a list. */
export function defaultTeamId(plan: ImportPlan, servers: readonly ScopeServer[], teams: ReadonlyArray<{ id: string; name: string }>, refs?: ReadonlySet<string>): string {
  const teamIds = [...new Set(servers.map((s) => s.teamId))];
  const byId = new Map(servers.map((s) => [s.id, s.teamId] as const));
  const tally = new Map<string, number>();
  for (const h of plan.preflight?.hosts ?? []) {
    if (refs && !refs.has(h.ref)) continue;
    const t = autoTargetOf(plan, h.ref);
    const team = t ? byId.get(t) : undefined;
    if (team) tally.set(team, (tally.get(team) ?? 0) + 1);
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (ranked.length > 0 && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) return ranked[0][0];
  const name = plan.preflight?.sourceTeam?.trim().toLowerCase();
  const named = name ? teams.filter((t) => teamIds.includes(t.id) && t.name.trim().toLowerCase() === name) : [];
  if (named.length === 1) return named[0].id;
  return teamIds.length === 1 ? teamIds[0] : "";
}

/**
 * What the step opens with: nothing picked. Not the servers the hub matched to a connected Tugra server (with a team mapping or after
 * the match step that is most of them, and the owner has to untick them), not the first server. A matched server still goes onto
 * its own machine as soon as the owner ticks it ({@link targetOf}); "Select connected" ticks them in one click. A source with several
 * servers opens on "A server" with none ticked, a source with one (or none shown) on "everything". Only a visit for one named server
 * or project ({@link focusSelection}) opens with that one ticked.
 */
export function autoSelection(plan: ImportPlan, shown?: ReadonlySet<string>): ScopeSelection {
  const rows = sourceHostRows(plan).filter((r) => !shown || shown.has(r.ref));
  if (rows.length > 1) return { ...emptySelection(), mode: "servers" };
  return emptySelection();
}

/**
 * Turn a selection into what the later steps need. `placed` has a target for each involved source server that has one (the pick, else a
 * sure match); a server with neither stays out of it and {@link scopeIssue} says so. A serverMap exists only when every involved server
 * is placed and more than one Tugra server is used. `allowed` (the chosen team's server ids, or a function giving them per source server when each source server has its own team) drops targets outside the team. `teamOf` lets the
 * scope say whether the targets sit in several teams.
 */
export function buildScope(plan: ImportPlan, sel: ScopeSelection, allowed?: ReadonlySet<string> | ((hostRef: string) => ReadonlySet<string> | undefined), teamOf?: (serverId: string) => string | undefined): ImportScope {
  const inScope = inScopeRefs(plan, sel);
  const hosts = involvedHosts(plan, inScope);
  const placed: Record<string, string> = {};
  const placementKind: Record<string, PlacementKind> = {};
  for (const h of hosts) {
    const id = targetOf(plan, sel, h.ref, typeof allowed === "function" ? allowed(h.ref) : allowed);
    if (!id) continue;
    placed[h.ref] = id;
    placementKind[h.ref] = placementKindOf(plan, h.ref, id);
  }
  const targets = [...new Set(Object.values(placed))];
  const complete = hosts.every((h) => placed[h.ref]);
  return {
    selection: sel,
    inScope,
    narrowed: plan.items.some((i) => isPlaceable(i) && !inScope.has(i.itemRef)),
    defaultServerId: hosts.length > 0 ? placed[hosts[0].ref] ?? "" : "",
    serverMap: complete && targets.length > 1 ? placed : undefined,
    placed,
    placementKind,
    ...(teamOf && new Set(targets.map((id) => teamOf(id) ?? id)).size > 1 ? { multiTeam: true } : {}),
  };
}

export type ScopeIssue = "nothing" | "target" | "teams" | "blocked" | "unready" | "limit" | "shared" | "partial";

/**
 * Why the selection cannot continue yet, or null: nothing picked, a source server without a target, targets in different teams, a
 * same-machine move that is not possible, a target that cannot take apps, or too many servers. Same-machine and copied moves in one go are fine: the
 * hub turns them into a campaign of runs (see lib/campaign.ts). Targets in several teams are fine too where a campaign carries the move (`multiTeamOk`,
 * Coolify): one campaign per team. Another source has one run, and a run belongs to one team.
 */
export function scopeIssue(
  plan: ImportPlan,
  scope: ImportScope,
  teamOf: (serverId: string) => string | undefined,
  readinessOf?: (serverId: string) => ServerReadiness,
  opts: { multiTeamOk?: boolean } = {},
): ScopeIssue | null {
  const apps = plan.items.filter((i) => isPlaceable(i) && scope.inScope.has(i.itemRef));
  if (apps.length === 0) return "nothing";
  const hosts = involvedHosts(plan, scope.inScope);
  if (hosts.some((h) => !scope.placed[h.ref])) return "target";
  const ids = hosts.map((h) => scope.placed[h.ref]);
  if (!opts.multiTeamOk && new Set(ids.map((id) => teamOf(id) ?? id)).size > 1) return "teams";
  if (hosts.some((h) => hostTugra(plan, h.ref)?.serverId === scope.placed[h.ref] && inPlaceBlock(plan, h.ref))) return "blocked";
  if (sharedTargetHosts(plan, scope)) return "shared";
  if (partialInPlaceHosts(plan, scope).length > 0) return "partial";
  if (readinessOf && ids.some((id) => readinessOf(id) !== "ready")) return "unready";
  if (hosts.length > SERVER_MAP_MAX) return "limit";
  return null;
}

/**
 * Two source servers that would land on one Tugra machine when one of them stays on it (two same-machine, or a copy onto the machine another
 * source server stays on): they would fight over the same proxy and ports. The two refs, or null. Copies of several source servers onto one other
 * server are fine (they travel together in one run).
 */
export function sharedTargetHosts(plan: ImportPlan, scope: Pick<ImportScope, "inScope" | "placed" | "placementKind">): [string, string] | null {
  const hosts = involvedHosts(plan, scope.inScope).map((h) => h.ref);
  const inPlaceBy = new Map<string, string>();
  for (const ref of hosts) {
    const id = scope.placed[ref];
    if (!id || scope.placementKind[ref] !== "in-place") continue;
    const first = inPlaceBy.get(id);
    if (first) return [first, ref];
    inPlaceBy.set(id, ref);
  }
  for (const ref of hosts) {
    const id = scope.placed[ref];
    const holder = id && scope.placementKind[ref] !== "in-place" ? inPlaceBy.get(id) : undefined;
    if (holder) return [holder, ref];
  }
  return null;
}

/**
 * Same-machine servers of which only part is in scope. The proxy swap takes the machine's ingress, so an app of it left out of the selection would
 * lose its address: such a server moves whole or goes to another server (the hub refuses the partial one too).
 */
export function partialInPlaceHosts(plan: ImportPlan, scope: Pick<ImportScope, "inScope" | "placementKind" | "narrowed">): string[] {
  if (!scope.narrowed) return [];
  const out: string[] = [];
  for (const h of involvedHosts(plan, scope.inScope)) {
    if (scope.placementKind[h.ref] !== "in-place") continue;
    if (plan.items.some((i) => isPlaceable(i) && hostOfItemRef(i.itemRef) === h.ref && !scope.inScope.has(i.itemRef))) out.push(h.ref);
  }
  return out;
}

/** Same-machine placements of a scope (how many source servers stay on their own box). */
export const inPlaceCount = (scope: Pick<ImportScope, "placementKind">): number => Object.values(scope.placementKind).filter((k) => k === "in-place").length;

// ───────────── what survives a refresh (names and ids only; never a token) ─────────────

const MAX_STORED = 4000;

/** The selection as JSON for sessionStorage: refs and ids only. */
export function serializeSelection(sel: ScopeSelection): string {
  return JSON.stringify({ v: 1, mode: sel.mode, hosts: [...sel.hosts].sort(), projects: [...sel.projects].sort(), extra: [...sel.extra].sort(), placement: sel.placement, ...(sel.teamId ? { teamId: sel.teamId } : {}) });
}

/** A selection read back from sessionStorage; anything that does not look like one is undefined (a stale or tampered value starts fresh). */
export function restoreSelection(raw: string | null | undefined): ScopeSelection | undefined {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.length <= MAX_STORED && v.every((x) => typeof x === "string" && x.length <= 200) ? (v as string[]) : null);
    const hosts = strs(o.hosts);
    const projects = strs(o.projects);
    const extra = strs(o.extra);
    const place = o.placement;
    if (o.v !== 1 || (o.mode !== "servers" && o.mode !== "projects" && o.mode !== "everything") || !hosts || !projects || !extra) return undefined;
    if (!place || typeof place !== "object" || Array.isArray(place)) return undefined;
    const placement: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(place as Record<string, unknown>)) {
      if (k === "__proto__" || typeof v !== "string" || k.length > 200 || v.length > 200) return undefined;
      placement[k] = v;
    }
    return { mode: o.mode, hosts: new Set(hosts), projects: new Set(projects), extra: new Set(extra), placement: { ...placement }, ...(typeof o.teamId === "string" && o.teamId ? { teamId: o.teamId } : {}) };
  } catch {
    return undefined;
  }
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

/** The notes of the plan: the ones about specific items only when one of those items is in scope (an unhealthy app of another team is not this move's note); every other note stays. */
export function scopedNotes(plan: ImportPlan, inScope: ReadonlySet<string>): string[] {
  const about = new Map<string, string[]>();
  for (const w of plan.scopedWarnings ?? []) about.set(w.text, [...(about.get(w.text) ?? []), ...w.itemRefs]);
  return plan.warnings.filter((w) => {
    const refs = about.get(w);
    return !refs || refs.some((r) => inScope.has(r));
  });
}

/** The plan as the later steps show it: only what is in scope (counts, blockers, coverage and the named preflight lists follow).
 *  planHash is kept, because the hub re-plans the whole source and the apply is bound to that hash. */
export function scopedPlan(plan: ImportPlan, inScope: ReadonlySet<string>): ImportPlan {
  if (plan.items.every((i) => inScope.has(i.itemRef))) return plan;
  const items = plan.items.filter((i) => inScope.has(i.itemRef));
  // A row follows the item it belongs to (its itemRef): two servers with an app "api" or a database "postgres" are told apart. A hub that
  // sends no itemRef on a row is matched by name, as before.
  const names = (kind: ImportPlanItem["kind"]) => new Set(items.filter((i) => i.kind === kind).map((i) => i.name));
  const dbNames = names("database");
  const svcNames = names("service");
  const appNames = names("app");
  const pf = plan.preflight;
  const preflight = pf
    ? {
        ...pf,
        databases: pf.databases.filter((d) => (d.itemRef ? inScope.has(d.itemRef) : dbNames.has(d.name))),
        services: pf.services.filter((s) => (s.itemRef ? inScope.has(s.itemRef) : svcNames.has(s.name))),
        volumes: pf.volumes?.filter((v) => (v.itemRef ? inScope.has(v.itemRef) : appNames.has(v.app))),
        sourceHealth: pf.sourceHealth?.filter((h) => inScope.has(h.itemRef)),
        coverage: pf.coverage ? { ...pf.coverage, apps: pf.coverage.apps.filter((a) => inScope.has(a.itemRef)), env: pf.coverage.env ? { apps: pf.coverage.env.apps.filter((a) => inScope.has(a.itemRef)) } : undefined } : undefined,
      }
    : undefined;
  const count = (k: ImportPlanItem["kind"]) => items.filter((i) => i.kind === k).length;
  return {
    ...plan,
    warnings: scopedNotes(plan, inScope),
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

/** True when this item's source server stays on its own machine (same machine, proxy swap): its data is not copied. */
export const isInPlaceItem = (scope: Pick<ImportScope, "placementKind"> | null | undefined, itemRef: string): boolean => scope?.placementKind[hostOfItemRef(itemRef)] === "in-place";

export interface PlacementSplit {
  /** The plan reduced to what moves to another server: the only part where a copy, the migrator and a data mode apply. */
  moved: ImportPlan;
  /** The source servers that stay on their own machine, with what lives on each (in-scope items only). */
  stays: SourceServerRow[];
}

/**
 * Split a (scoped) plan by where its items go. An item whose source server is placed on the machine it already runs on is "in place": the data stays
 * where it is, so none of the migrator, data-mode or volume-copy text applies to it. Without a scope nothing is known to stay, so everything counts as moved.
 */
export function splitByPlacement(plan: ImportPlan, scope: Pick<ImportScope, "placementKind"> | null | undefined): PlacementSplit {
  const inPlace = plan.items.filter((i) => isInPlaceItem(scope, i.itemRef));
  if (inPlace.length === 0) return { moved: plan, stays: [] };
  const stayRefs = new Set(inPlace.map((i) => i.itemRef));
  const moved = scopedPlan(plan, new Set(plan.items.filter((i) => !stayRefs.has(i.itemRef)).map((i) => i.itemRef)));
  return { moved, stays: sourceServersOf(inPlace, plan.preflight?.hosts) };
}

/** The "not carried" fields of a service stack that describe the copy path: its data volumes and an object store's buckets. For a stack that stays on its own machine
 *  none of it is true (the takeover maps the same data in place), so only a stack that moves keeps them. */
const isCopyPathField = (field: string): boolean => field === "objectData" || field.startsWith("volume:");

/**
 * The plan with the copy-path review notes of the service stacks that stay in place taken out of its "not carried" list (a stack that moves keeps them).
 * What else the stack does not carry (dropped members, ports, config files) stays. Returns the same plan when nothing changes.
 */
export function withoutInPlaceCopyNotes(plan: ImportPlan, scope: Pick<ImportScope, "placementKind"> | null | undefined): ImportPlan {
  const cov = plan.preflight?.coverage;
  if (!cov || !scope) return plan;
  let changed = false;
  const apps = cov.apps.flatMap((a) => {
    if (!a.itemRef.startsWith("service:") || !isInPlaceItem(scope, a.itemRef)) return [a];
    const kept = a.notCarried.filter((n) => !isCopyPathField(n.field));
    if (kept.length === a.notCarried.length) return [a];
    changed = true;
    return kept.length ? [{ ...a, notCarried: kept }] : [];
  });
  return changed ? { ...plan, preflight: { ...plan.preflight!, coverage: { ...cov, apps } } } : plan;
}

/** One word for the whole move: every placed server in place, every one elsewhere, a mix, or nothing placed yet. */
export function overallPlacement(scope: Pick<ImportScope, "placementKind"> | null | undefined): "in-place" | "other-server" | "mixed" | null {
  const kinds = new Set(Object.values(scope?.placementKind ?? {}));
  if (kinds.size === 0) return null;
  if (kinds.size > 1) return "mixed";
  return kinds.has("in-place") ? "in-place" : "other-server";
}

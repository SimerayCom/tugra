import { createHash } from "node:crypto";
import { z } from "zod";
import type { ForeignFleet, ImportPlan } from "./foreign-fleet";
import { mapBuildPack } from "./buildpack-map";
import { isRunnable } from "./import-executor.logic";

/**
 * Editable import mapping — the PURE half (no I/O, no Prisma, no Nest): the mapping document schema, the name
 * policy, the canonical hash, and `resolveMapping`, which overlays a mapping on a plan to produce the effective
 * per-item names/placement plus every conflict. It never touches `planImport`: the planHash stays a pure
 * source-drift guard, and a separate `mappingHash` binds an apply to the reviewed mapping.
 *
 * A mapping carries NAMES and PLACEMENT only — never a secret. It is explicit rows only (no rules/globs/regex).
 */

// ── schema ─────────────────────────────────────────────────────────────────────────────────────────────

/** A plan itemRef for an app or database (`<kind>:<serverRef|_>:<sourceRef>`). Volume keys are a 400. */
const ITEM_KEY = z.string().regex(/^(app|database):[\x21-\x7e]{1,280}$/);
/** A source project/environment/provider ref. `__proto__`/`constructor`/`prototype` are refused so a parsed record
 *  can never mutate an object prototype. */
const REF = z
  .string()
  .regex(/^[\x21-\x7e]{1,200}$/)
  .refine((k) => k !== "__proto__" && k !== "constructor" && k !== "prototype", "reserved key");
/** A candidate display name. Only bounded here (DoS) — the per-kind cap, charset and emptiness are enforced by
 *  {@link validateName} in the resolver so each problem is a localized per-item conflict, not a whole-doc 400. */
const NAME = z.string().max(400);

export const ImportMappingItemSchema = z
  .object({
    include: z.boolean().optional(), // false => the task is SKIPPED "excluded by mapping"
    name: NAME.optional(), // target app/DB display name
    project: NAME.optional(), // target project name (find-or-create on the target team)
    environment: NAME.optional(), // target environment name (find-or-create)
    containerAlias: z.string().max(64).nullable().optional(), // apps only; null = none/clear
    dbIdentifier: z.string().max(63).optional(), // DBs only (fresh-credentials path)
  })
  .strict();
export type ImportMappingItem = z.infer<typeof ImportMappingItemSchema>;

export const ImportMappingDocSchema = z
  .object({
    version: z.literal(1),
    scope: z.object({ sourceKind: z.enum(["coolify", "dokploy"]), scopeKey: z.string().max(64).optional() }).strict().optional(),
    items: z.record(ITEM_KEY, ImportMappingItemSchema).default({}),
    projects: z.record(REF, z.object({ name: NAME.optional(), environments: z.record(REF, NAME).optional() }).strict()).default({}),
    gitSources: z.record(REF, z.object({ name: NAME }).strict()).default({}),
    acks: z.array(z.string().max(340)).max(5000).default([]),
  })
  .strict()
  .refine((d) => Object.keys(d.items).length <= 5000, "too many items");
export type ImportMappingDoc = z.infer<typeof ImportMappingDocSchema>;

/** A document with nothing in it (what a fresh profile / a "reset all" is). */
export const EMPTY_MAPPING: ImportMappingDoc = { version: 1, items: {}, projects: {}, gitSources: {}, acks: [] };

// ── name policy ────────────────────────────────────────────────────────────────────────────────────────

/** Per-kind caps, in code points (projects/environments additionally in UTF-16 units — see validateName). Apps: RenameSchema max 100. Databases: 60 (the stricter of the DB DTOs: create
 *  has no cap, clone clamps to 60, rename allows 100). Projects/environments: projects/dto.ts 80. */
export const NAME_MAX = { app: 100, database: 60, project: 80, environment: 80, gitsource: 80 } as const;
export type NameKind = keyof typeof NAME_MAX;

// Control characters, bidi embedding/override/isolate marks, and zero-width characters.
const FORBIDDEN = /[\p{Cc}‪-‮⁦-⁩​-‍⁠﻿]/u;

export type NameCheck = { ok: true; value: string } | { ok: false; code: "name.invalid" | "name.too_long" };

/** NFC-normalize + trim, then REJECT (never truncate) an empty name, a forbidden character, or one over the cap. */
export function validateName(kind: NameKind, raw: string): NameCheck {
  const value = raw.normalize("NFC").trim();
  if (!value) return { ok: false, code: "name.invalid" };
  if (FORBIDDEN.test(value)) return { ok: false, code: "name.invalid" };
  if ([...value].length > NAME_MAX[kind]) return { ok: false, code: "name.too_long" };
  // Projects and environments go through ProjectsService.findOrCreateForImport, which slices to 80 UTF-16 units:
  // a name that fits in code points but not in units would be silently cut there, so reject it here instead.
  if ((kind === "project" || kind === "environment") && value.length > NAME_MAX[kind]) return { ok: false, code: "name.too_long" };
  return { ok: true, value };
}

const ALIAS_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_ALIAS_RE = /^tugra[-_]/i;
const DB_IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
export const isValidAlias = (s: string): boolean => ALIAS_RE.test(s);
export const isValidDbIdentifier = (s: string): boolean => DB_IDENT_RE.test(s);

/** The production environment name a project-only placement lands in. */
export const DEFAULT_ENVIRONMENT = "production";

// ── base url / canonical json / hash ───────────────────────────────────────────────────────────────────

/** Normalise a source base URL for the profile key: lowercase scheme+host, default port and trailing slash
 *  stripped, no credentials/query/hash. Falls back to the trimmed lowercase input when it is not parseable. */
export function normalizeBaseUrl(raw: string): string {
  const s = raw.trim();
  try {
    const u = new URL(s);
    const port = (u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80") ? "" : u.port;
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.hostname.toLowerCase()}${port ? `:${port}` : ""}${path}`;
  } catch {
    return s.toLowerCase().replace(/\/+$/, "");
  }
}

/** Recursively sorted keys, no whitespace, strings NFC; undefined/null fields and empty objects dropped. */
export function canonicalJson(x: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "string") return v.normalize("NFC");
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const n = norm((v as Record<string, unknown>)[k]);
        if (n === undefined || n === null) continue;
        if (typeof n === "object" && !Array.isArray(n) && Object.keys(n as object).length === 0) continue;
        out[k.normalize("NFC")] = n;
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(x));
}

/** Context-free normalisation (the display hash of a stored profile): drops `scope`, `include:true`, empty
 *  entries, and sorts/dedupes acks. `resolveMapping` additionally drops values equal to the source default. */
export function normalizeDoc(doc: ImportMappingDoc): Record<string, unknown> {
  const items: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.items)) {
    const e: Record<string, unknown> = {};
    if (v.include === false) e.include = false;
    if (v.name !== undefined) e.name = v.name.normalize("NFC").trim();
    if (v.project !== undefined) e.project = v.project.normalize("NFC").trim();
    if (v.environment !== undefined) e.environment = v.environment.normalize("NFC").trim();
    if (v.containerAlias !== undefined) e.containerAlias = v.containerAlias === null ? "" : v.containerAlias;
    if (v.dbIdentifier !== undefined) e.dbIdentifier = v.dbIdentifier;
    if (Object.keys(e).length) items[k] = e;
  }
  return { items, projects: doc.projects, gitSources: doc.gitSources, acks: [...new Set(doc.acks)].sort() };
}

export interface MappingHashInput {
  planHash: string;
  targetServerId: string;
  environmentId?: string;
  reconcile: boolean;
}
export function mappingHashOf(norm: unknown, i: MappingHashInput): string {
  return createHash("sha256")
    .update(canonicalJson({ v: 1, planHash: i.planHash, targetServerId: i.targetServerId, environmentId: i.environmentId ?? null, reconcile: !!i.reconcile, mapping: norm }))
    .digest("hex")
    .slice(0, 32);
}
/** The standalone display hash of a document alone (no plan/target binding). */
export const docHash = (doc: ImportMappingDoc): string => createHash("sha256").update(canonicalJson(normalizeDoc(doc))).digest("hex").slice(0, 32);

/** True when the document changes nothing (a fresh/identity profile): used by the "profile exists but no mapping
 *  sent" fail-closed rule, which must not trip on an empty profile. */
export function isEmptyDoc(doc: ImportMappingDoc): boolean {
  const n = normalizeDoc(doc);
  return Object.keys(n.items as object).length === 0 && Object.keys(doc.projects).length === 0 && Object.keys(doc.gitSources).length === 0 && doc.acks.length === 0;
}

// ── resolver types ─────────────────────────────────────────────────────────────────────────────────────

export interface TargetSnapshot {
  teamId: string;
  serverId: string;
  canCreateProjects: boolean;
  /** project name (exact) → its id and environments (name → id). */
  projects: Map<string, { id: string; envs: Map<string, string> }>;
  /** every environment id of the team (for the `environmentId` membership check). */
  envIds: Set<string>;
  /** the team's default environment id (read-only lookup; null when there is none yet). */
  defaultEnvironmentId: string | null;
  /** environment id → lowercased resource names already there. */
  namesByEnv: Map<string, { apps: Map<string, string>; dbs: Map<string, string> }>;
  /** containerAlias + networkAliases of apps on the server, lowercased. */
  aliasesOnServer: Set<string>;
  /** itemRef → live resource a DONE task of THIS server created. */
  existing: Map<string, { resourceType: "application" | "database"; resourceId: string; name: string; environmentId: string; containerAlias?: string | null }>;
  /** itemRef → DONE on ANOTHER server (resource live). */
  elsewhere: Map<string, { serverId: string; serverName: string }>;
  /** GitHub App ids that already have a Tugra GitSource on the team. */
  gitSourcesByAppId: Set<string>;
}

export type ConflictLevel = "error" | "warn" | "info";
export interface Conflict {
  code: string;
  level: ConflictLevel;
  itemRef?: string;
  ref?: string;
  field?: "name" | "project" | "environment" | "containerAlias" | "dbIdentifier";
  params: Record<string, string | number>;
  requiresAck?: boolean;
  ackKey?: string;
  acked?: boolean;
}
export type EffectiveChange = "name" | "project" | "environment" | "containerAlias" | "include";
export interface EffectiveItem {
  itemRef: string;
  kind: "app" | "database";
  sourceName: string;
  include: boolean;
  name: string;
  project: string | null;
  environment: string | null;
  containerAlias?: string | null;
  dbIdentifier?: string;
  origin: { name: "source" | "mapping"; placement: "mapping" | "tree" | "default" | "selected"; alias?: "mapping"; dbIdentifier?: "mapping" | "derived" };
  status: "pending" | "blocked" | "already_imported" | "excluded";
  existing?: { resourceType: string; resourceId: string; name: string };
  changed: EffectiveChange[];
  drift?: Array<"name" | "environment" | "containerAlias">;
}
export interface ResolvedProject {
  name: string;
  environments: string[];
  willCreate: boolean;
  envsToCreate: string[];
  itemCount: number;
}
export interface ResolvedMapping {
  version: 1;
  effective: EffectiveItem[];
  projects: ResolvedProject[];
  gitSources: Array<{ ref: string; sourceName: string; name: string; exists: boolean }>;
  conflicts: Conflict[];
  orphans: string[];
  mappingHash: string;
  counts: { renamed: number; moved: number; excluded: number; aliased: number; newProjects: number; newEnvironments: number };
}
export interface ResolveOpts extends MappingHashInput {
  /** the import session the mapping is being resolved for (checked against `doc.scope`). */
  session?: { sourceKind: string; scopeKey: string };
}

const lc = (s: string): string => s.toLowerCase();
const ns = (...parts: string[]): string => parts.join("\u0000");

/** The default display name of a GitHub App provider (identical to what the executor creates today). */
export const gitProviderDefaultName = (p: { appName?: string; appSlug?: string; appId?: string }): string => p.appName || p.appSlug || `GitHub App ${p.appId}`;

/**
 * Pure: overlay `doc` on `plan`/`fleet` against an optional target snapshot. Resolves the effective name and
 * placement of every app/database item, finds every conflict (error / needs-ack / warn / info), and binds the
 * result to the plan + target with `mappingHash`. `snap` is null for shape-only checks and pure specs: every
 * target-state check is then skipped.
 */
export function resolveMapping(fleet: ForeignFleet, plan: ImportPlan, doc: ImportMappingDoc, snap: TargetSnapshot | null, opts: ResolveOpts): ResolvedMapping {
  const conflicts: Conflict[] = [];
  const add = (c: Conflict) => {
    conflicts.push(c);
  };
  const acks = new Set(doc.acks);
  const ack = (c: Conflict): Conflict => {
    c.requiresAck = true;
    c.acked = !!c.ackKey && acks.has(c.ackKey);
    return c;
  };

  // scope
  if (doc.scope && opts.session) {
    if (doc.scope.sourceKind !== opts.session.sourceKind || (doc.scope.scopeKey !== undefined && doc.scope.scopeKey !== opts.session.scopeKey)) {
      add({ code: "scope.mismatch", level: "error", params: { expected: opts.session.scopeKey || opts.session.sourceKind } });
    }
  }
  if (snap && opts.environmentId && !snap.envIds.has(opts.environmentId)) add({ code: "env.not_in_team", level: "error", params: {} });

  const appByRef = new Map(fleet.apps.map((a) => [`app:${a.serverRef ?? "_"}:${a.sourceRef}`, a]));
  const dbByRef = new Map(fleet.databases.map((d) => [`database:${d.serverRef ?? "_"}:${d.sourceRef}`, d]));
  const planByRef = new Map(plan.items.map((i) => [i.itemRef, i]));
  const projectByRef = new Map((fleet.projects ?? []).map((p) => [p.ref, p]));

  // orphans: mapping keys the FRESH plan no longer has
  const orphans = Object.keys(doc.items)
    .filter((k) => !planByRef.has(k) || planByRef.get(k)!.kind === "volume" || planByRef.get(k)!.kind === "service")
    .sort();
  for (const k of orphans) add({ code: "key.orphan", level: "error", itemRef: k, params: {} });
  for (const ref of Object.keys(doc.projects)) if (!projectByRef.has(ref)) add({ code: "key.stale_ref", level: "warn", ref, params: { section: "projects" } });

  const sourceDefaults = new Map<string, { name: string; project?: string; environment?: string }>();
  const effective: EffectiveItem[] = [];
  const aliasSeen = new Map<string, string>(); // lowercased alias → first itemRef in the doc
  const bad = (code: string, itemRef: string, field: Conflict["field"], params: Conflict["params"] = {}) => add({ code, level: "error", itemRef, field, params });

  for (const item of plan.items) {
    // Services (Coolify stacks → stopped compose apps) take their choices from `serviceChoices`, not the mapping: skipped here.
    if (item.kind === "volume" || item.kind === "service") continue;
    const kind = item.kind;
    const app = kind === "app" ? appByRef.get(item.itemRef) : undefined;
    const db = kind === "database" ? dbByRef.get(item.itemRef) : undefined;
    const res = app ?? db;
    const entry = doc.items[item.itemRef] ?? {};
    const existing = snap?.existing.get(item.itemRef);
    const dup = !!existing;
    const include = entry.include !== false;
    const runnable = isRunnable(item, app, db, dup);
    const status: EffectiveItem["status"] = !include ? "excluded" : dup ? "already_imported" : runnable ? "pending" : "blocked";
    const changed: EffectiveChange[] = [];
    if (!include) changed.push("include");

    // ── name
    let name = item.name;
    let nameOrigin: "source" | "mapping" = "source";
    if (entry.name !== undefined) {
      const v = validateName(kind, entry.name);
      if (!v.ok) bad(v.code, item.itemRef, "name", v.code === "name.too_long" ? { max: NAME_MAX[kind] } : {});
      else if (v.value !== item.name) {
        name = v.value;
        nameOrigin = "mapping";
        changed.push("name");
      }
    }

    // ── placement (precedence: item > Dokploy tree with renames > selected environment > default)
    const treeProject = res?.projectRef ? projectByRef.get(res.projectRef) : undefined;
    const treeEnv = treeProject?.environments.find((e) => e.ref === res?.environmentRef);
    const treeProjectName = treeProject && treeEnv ? doc.projects[treeProject.ref]?.name?.normalize("NFC").trim() || treeProject.name : undefined;
    const treeEnvName = treeProject && treeEnv ? doc.projects[treeProject.ref]?.environments?.[treeEnv.ref]?.normalize("NFC").trim() || treeEnv.name : undefined;
    let project: string | null = null;
    let environment: string | null = null;
    let placement: EffectiveItem["origin"]["placement"] = opts.environmentId ? "selected" : "default";
    if (treeProjectName && treeEnvName) {
      project = treeProjectName;
      environment = treeEnvName;
      placement = "tree";
    }
    sourceDefaults.set(item.itemRef, { name: item.name, project: treeProject?.name, environment: treeEnv?.name });
    if (entry.project !== undefined || entry.environment !== undefined) {
      let p = project;
      let e = environment;
      if (entry.project !== undefined) {
        const v = validateName("project", entry.project);
        if (!v.ok) bad(v.code, item.itemRef, "project", v.code === "name.too_long" ? { max: NAME_MAX.project } : {});
        else {
          if (v.value !== project) changed.push("project");
          p = v.value;
          e = entry.environment === undefined ? DEFAULT_ENVIRONMENT : e;
        }
      }
      if (entry.environment !== undefined) {
        const v = validateName("environment", entry.environment);
        if (!v.ok) bad(v.code, item.itemRef, "environment", v.code === "name.too_long" ? { max: NAME_MAX.environment } : {});
        else {
          if (v.value !== environment) changed.push("environment");
          e = v.value;
        }
      }
      if (e !== null && p === null) bad("placement.project_required", item.itemRef, "environment");
      project = p;
      environment = e;
      placement = "mapping";
    }

    // ── container alias (apps only)
    let containerAlias: string | null | undefined;
    if (entry.containerAlias !== undefined) {
      containerAlias = entry.containerAlias;
      const a = entry.containerAlias;
      if (kind === "database" || (app && mapBuildPack(app).source === "COMPOSE") || !include) {
        if (a !== null) bad("alias.unsupported", item.itemRef, "containerAlias");
      } else if (a !== null) {
        if (!isValidAlias(a)) bad("alias.invalid", item.itemRef, "containerAlias");
        else if (RESERVED_ALIAS_RE.test(a)) bad("alias.reserved", item.itemRef, "containerAlias");
        else {
          const key = lc(a);
          const own = existing?.containerAlias ? lc(existing.containerAlias) : undefined;
          if (aliasSeen.has(key) || (snap?.aliasesOnServer.has(key) && key !== own)) bad("alias.taken", item.itemRef, "containerAlias", { alias: a });
          else aliasSeen.set(key, item.itemRef);
        }
      }
      if (a !== null || existing?.containerAlias) changed.push("containerAlias");
    }

    // ── database identifier (fresh-credentials path only)
    let dbIdentifier: string | undefined;
    if (entry.dbIdentifier !== undefined) {
      if (kind === "app") bad("db.identifier_on_app", item.itemRef, "dbIdentifier");
      else if (!isValidDbIdentifier(entry.dbIdentifier)) bad("db.identifier_invalid", item.itemRef, "dbIdentifier");
      else if (dup) bad("db.identifier_on_imported", item.itemRef, "dbIdentifier");
      else {
        dbIdentifier = entry.dbIdentifier;
        add({ code: "db.identifier_fresh_only", level: "warn", itemRef: item.itemRef, field: "dbIdentifier", params: {} });
      }
    } else if (kind === "database" && nameOrigin === "mapping" && !dup && include) {
      add({ code: "db.rename_identifier_kept", level: "warn", itemRef: item.itemRef, field: "name", params: {} });
    }

    // ── cross-server duplicate guard
    const elsewhere = snap?.elsewhere.get(item.itemRef);
    if (elsewhere && include && !dup) {
      add(ack({ code: "item.imported_elsewhere", level: "warn", itemRef: item.itemRef, ackKey: `item.imported_elsewhere:${item.itemRef}`, params: { server: elsewhere.serverName } }));
    }

    // ── drift of an already-imported item (reported; reconcile applies it)
    let drift: EffectiveItem["drift"];
    if (existing && include) {
      const d: NonNullable<EffectiveItem["drift"]> = [];
      if (nameOrigin === "mapping" && name !== existing.name) d.push("name");
      if (placement === "mapping" || placement === "tree") {
        const envId = project && environment ? snap?.projects.get(project)?.envs.get(environment) : undefined;
        if (envId !== existing.environmentId) d.push("environment");
      }
      if (entry.containerAlias !== undefined && kind === "app" && (containerAlias ?? null) !== (existing.containerAlias ?? null)) d.push("containerAlias");
      if (d.length) {
        drift = d;
        add({ code: "item.already_imported_drift", level: "warn", itemRef: item.itemRef, params: { fields: d.join(","), reconcile: opts.reconcile ? 1 : 0 } });
      }
    }

    effective.push({
      itemRef: item.itemRef,
      kind,
      sourceName: item.name,
      include,
      name,
      project,
      environment,
      ...(kind === "app" && entry.containerAlias !== undefined ? { containerAlias } : {}),
      ...(dbIdentifier !== undefined ? { dbIdentifier } : {}),
      origin: { name: nameOrigin, placement, ...(entry.containerAlias !== undefined ? { alias: "mapping" as const } : {}), ...(dbIdentifier !== undefined ? { dbIdentifier: "mapping" as const } : {}) },
      status,
      ...(existing ? { existing: { resourceType: existing.resourceType, resourceId: existing.resourceId, name: existing.name } } : {}),
      changed,
      ...(drift ? { drift } : {}),
    });
  }

  // ── name duplicates (same kind, same effective environment, case-insensitive), within the doc and vs the target
  const envKeyOf = (e: EffectiveItem): { key: string; envId?: string } | undefined => {
    if (e.project && e.environment) return { key: ns("n", e.project, e.environment), envId: snap?.projects.get(e.project)?.envs.get(e.environment) };
    const envId = opts.environmentId ?? snap?.defaultEnvironmentId ?? undefined;
    return envId ? { key: ns("e", envId), envId } : { key: ns("d") };
  };
  const pending = effective.filter((e) => e.status === "pending");
  const bySlot = new Map<string, EffectiveItem[]>();
  for (const e of pending) {
    const k = envKeyOf(e)!;
    const slot = ns(e.kind, k.key, lc(e.name));
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), e]);
  }
  for (const e of pending) {
    const k = envKeyOf(e)!;
    const group = bySlot.get(ns(e.kind, k.key, lc(e.name))) ?? [];
    let clash = group.length > 1;
    if (!clash && k.envId && snap) {
      const names = snap.namesByEnv.get(k.envId);
      clash = !!(e.kind === "app" ? names?.apps : names?.dbs)?.has(lc(e.name));
    }
    if (clash) add(ack({ code: "name.duplicate", level: "warn", itemRef: e.itemRef, field: "name", ackKey: `name.duplicate:${e.itemRef}`, params: { name: e.name } }));
  }
  if (snap) {
    for (const e of pending) {
      // case-only match against an existing project / environment name
      if (e.project) {
        const exact = snap.projects.has(e.project);
        if (!exact && [...snap.projects.keys()].some((n) => lc(n) === lc(e.project!))) add({ code: "name.case_only", level: "warn", itemRef: e.itemRef, field: "project", params: { name: e.project } });
      }
    }
  }

  // ── dependencies on excluded databases
  const excludedRefs = new Set(effective.filter((e) => e.status === "excluded").map((e) => e.itemRef));
  for (const e of pending) {
    const dependsOn = planByRef.get(e.itemRef)?.dependsOn ?? [];
    for (const d of dependsOn) {
      if (excludedRefs.has(d) && d.startsWith("database:")) add({ code: "dep.excluded", level: "warn", itemRef: e.itemRef, params: { dependency: effective.find((x) => x.itemRef === d)?.name ?? d } });
    }
  }

  // ── project / environment groups (only what a runnable item — or a reconcile move — actually uses)
  const usesGroup = (e: EffectiveItem) => e.status === "pending" || (opts.reconcile && e.status === "already_imported" && !!e.drift?.includes("environment"));
  const groups = new Map<string, { project: string; environment: string; items: number }>();
  const sourcesByProject = new Map<string, Set<string>>();
  for (const e of effective) {
    if (!usesGroup(e) || !e.project || !e.environment) continue;
    const key = ns(e.project, e.environment);
    const g = groups.get(key) ?? { project: e.project, environment: e.environment, items: 0 };
    g.items++;
    groups.set(key, g);
    const res = e.kind === "app" ? appByRef.get(e.itemRef) : dbByRef.get(e.itemRef);
    const srcProject = res?.projectRef ?? "_";
    sourcesByProject.set(e.project, (sourcesByProject.get(e.project) ?? new Set()).add(srcProject));
  }
  const projects: ResolvedProject[] = [];
  for (const name of [...new Set([...groups.values()].map((g) => g.project))].sort()) {
    const envs = [...groups.values()].filter((g) => g.project === name);
    const existingProject = snap?.projects.get(name);
    const envsToCreate = envs.map((g) => g.environment).filter((en) => !existingProject?.envs.has(en));
    projects.push({ name, environments: envs.map((g) => g.environment).sort(), willCreate: !!snap && !existingProject, envsToCreate: snap ? envsToCreate.sort() : [], itemCount: envs.reduce((n, g) => n + g.items, 0) });
    if (snap && existingProject) {
      let existingResources = 0;
      for (const id of existingProject.envs.values()) {
        const n = snap.namesByEnv.get(id);
        existingResources += (n?.apps.size ?? 0) + (n?.dbs.size ?? 0);
      }
      add(ack({ code: "project.merge_existing", level: "warn", ref: name, ackKey: `project.merge_existing:${lc(name)}`, params: { name, existing: existingResources } }));
    }
    if ((sourcesByProject.get(name)?.size ?? 0) > 1) add(ack({ code: "project.merge_sources", level: "warn", ref: name, ackKey: `project.merge_sources:${lc(name)}`, params: { name, sources: sourcesByProject.get(name)!.size } }));
  }
  const newProjects = projects.filter((p) => p.willCreate).length;
  const newEnvironments = projects.reduce((n, p) => n + p.envsToCreate.length, 0);
  if (snap && !snap.canCreateProjects && (newProjects > 0 || newEnvironments > 0)) add({ code: "perm.projects", level: "error", params: {} });
  if (newProjects > 0 || newEnvironments > 0) add({ code: "tree.not_rolled_back", level: "info", params: { projects: newProjects, environments: newEnvironments } });
  const synthetic = effective.filter((e) => (e.kind === "app" ? appByRef.get(e.itemRef) : dbByRef.get(e.itemRef))?.environmentRef?.endsWith("#production")).length;
  if (synthetic > 0) add({ code: "placement.synthetic", level: "info", params: { count: synthetic } });

  // ── git sources (name applies on create only)
  const gitSources: ResolvedMapping["gitSources"] = [];
  for (const p of fleet.gitProviders ?? []) {
    const sourceName = gitProviderDefaultName(p);
    const entry = doc.gitSources[p.ref];
    let name = sourceName;
    if (entry) {
      const v = validateName("gitsource", entry.name);
      if (!v.ok) add({ code: v.code, level: "error", ref: p.ref, params: v.code === "name.too_long" ? { max: NAME_MAX.gitsource } : {} });
      else name = v.value;
    }
    const exists = !!p.appId && !!snap?.gitSourcesByAppId.has(p.appId);
    if (entry && exists && name !== sourceName) add({ code: "gitsource.exists_not_renamed", level: "warn", ref: p.ref, params: {} });
    gitSources.push({ ref: p.ref, sourceName, name, exists });
  }
  for (const ref of Object.keys(doc.gitSources)) if (!(fleet.gitProviders ?? []).some((p) => p.ref === ref)) add({ code: "key.stale_ref", level: "warn", ref, params: { section: "gitSources" } });

  // ── hash: the doc reduced to what differs from the source default (so an identity doc == an empty doc)
  const normItems: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.items)) {
    const d = sourceDefaults.get(k);
    const e: Record<string, unknown> = {};
    if (v.include === false) e.include = false;
    const nm = v.name?.normalize("NFC").trim();
    if (nm !== undefined && nm !== d?.name) e.name = nm;
    const pr = v.project?.normalize("NFC").trim();
    if (pr !== undefined && pr !== d?.project) e.project = pr;
    const en = v.environment?.normalize("NFC").trim();
    if (en !== undefined && en !== d?.environment) e.environment = en;
    if (v.containerAlias !== undefined) e.containerAlias = v.containerAlias === null ? "" : v.containerAlias;
    if (v.dbIdentifier !== undefined) e.dbIdentifier = v.dbIdentifier;
    if (Object.keys(e).length) normItems[k] = e;
  }
  const normProjects: Record<string, unknown> = {};
  for (const [ref, v] of Object.entries(doc.projects)) {
    const sp = projectByRef.get(ref);
    const e: Record<string, unknown> = {};
    const nm = v.name?.normalize("NFC").trim();
    if (nm !== undefined && nm !== sp?.name) e.name = nm;
    const envs: Record<string, string> = {};
    for (const [er, en] of Object.entries(v.environments ?? {})) {
      const n = en.normalize("NFC").trim();
      if (n !== sp?.environments.find((x) => x.ref === er)?.name) envs[er] = n;
    }
    if (Object.keys(envs).length) e.environments = envs;
    if (Object.keys(e).length) normProjects[ref] = e;
  }
  const normGit: Record<string, unknown> = {};
  for (const [ref, v] of Object.entries(doc.gitSources)) {
    const sp = (fleet.gitProviders ?? []).find((p) => p.ref === ref);
    const n = v.name.normalize("NFC").trim();
    if (!sp || n !== gitProviderDefaultName(sp)) normGit[ref] = { name: n };
  }
  const mappingHash = mappingHashOf({ items: normItems, projects: normProjects, gitSources: normGit, acks: [...new Set(doc.acks)].sort() }, opts);

  const counts = {
    renamed: effective.filter((e) => e.changed.includes("name")).length,
    moved: effective.filter((e) => e.changed.includes("project") || e.changed.includes("environment")).length,
    excluded: effective.filter((e) => e.status === "excluded").length,
    aliased: effective.filter((e) => e.containerAlias).length,
    newProjects,
    newEnvironments,
  };
  return { version: 1, effective, projects, gitSources, conflicts, orphans, mappingHash, counts };
}

/** ERROR conflicts that make an apply impossible (orphans are reported separately and raise their own 409). */
export const blockingErrors = (r: ResolvedMapping): Conflict[] => r.conflicts.filter((c) => c.level === "error" && c.code !== "key.orphan");
/** requiresAck conflicts whose exact ackKey is not in the document's acks. */
export const unackedConflicts = (r: ResolvedMapping): Conflict[] => r.conflicts.filter((c) => c.requiresAck && !c.acked);

import { createHash } from "node:crypto";
import type {
  ForeignApp,
  ForeignDb,
  ForeignFleet,
  ForeignProject,
  ForeignVolume,
  ImportOptions,
  ImportPlan,
  ImportPlanItem,
  ImportRisk,
} from "./foreign-fleet";
import { mapBuildPack } from "./buildpack-map";
import { foreignAppToVolumes } from "./apply-map";
import { transformServiceCompose, type ServiceTransformResult } from "./import-service-map";
import type { ForeignService } from "./foreign-fleet";
import { TEMPLATES } from "../templates/catalog";

// Engines whose CONFIG cannot be imported (the planner emits a blocker; the executor skips the item, so NO
// target database is created). Exported so the preflight classifies them identically — one source, no drift.
export const UNSUPPORTED_DB_IMPORT = new Set(["LIBSQL"]); // no logical dump/restore pipeline yet (volume-copy only)

export const ns = (kind: string, serverRef: string | undefined, ref: string): string => `${kind}:${serverRef ?? "_"}:${ref}`;
const volKey = (v: ForeignVolume): string => v.name ?? v.hostPath ?? v.mountPath;

/**
 * Pure, deterministic dry-run: turn a discovered {@link ForeignFleet} into an {@link ImportPlan} — a preview
 * of the Tugra resources an import would create, with per-item risks (lossy/dropped/blocking) and a
 * dependency order (databases and volumes before the apps that use them). No I/O, no secrets, no persistence.
 */
export function planImport(fleet: ForeignFleet, options: ImportOptions): ImportPlan {
  const dbByRef = new Map(fleet.databases.map((d) => [d.sourceRef, d]));
  // local-docker adopts in place and re-attaches the original named volumes by name; every other source
  // does NOT copy volume data yet (the user must copy it to the target before cutover).
  const carried = options.sourceKind === "local-docker";

  const dbItems = fleet.databases.map((db) => planDatabase(db, treeRisk(fleet.projects, db, "db.project"), options.dbDataModes?.[ns("database", db.serverRef, db.sourceRef)] === "volume"));

  // Volumes: standalone + app-owned, deduped by their namespaced itemRef.
  const volItems = new Map<string, ImportPlanItem>();
  for (const v of fleet.volumes) {
    const it = planVolume(v, undefined, carried);
    volItems.set(it.itemRef, it);
  }
  for (const app of fleet.apps) {
    for (const v of app.volumes ?? []) {
      const it = planVolume(v, app.serverRef, carried);
      if (!volItems.has(it.itemRef)) volItems.set(it.itemRef, it);
    }
  }

  const appItems = fleet.apps.map((app) => planApp(app, dbByRef, carried, treeRisk(fleet.projects, app, "app.project")));

  // Services (Coolify stacks) become stopped compose apps. Only the sources that implement `fetchServiceBundle` can carry
  // them, but the plan classifies every discovered service honestly. A fleet without services adds nothing here.
  const serviceItems = (fleet.services ?? []).map((svc) => planService(svc));

  const items = [...dbItems, ...volItems.values(), ...appItems, ...serviceItems];
  const totals = {
    apps: fleet.apps.length,
    databases: fleet.databases.length,
    volumes: volItems.size,
    blockers: items.reduce((n, it) => n + it.risks.filter((r) => r.level === "blocker").length, 0),
    ...(serviceItems.length ? { services: serviceItems.length } : {}),
  };
  // Deterministic: depends only on the plan content + options (no time/random). Items are sorted by their
  // itemRef first, so the hash is independent of discovery order (two scans of an unchanged host hash equal
  // — the apply-time stale-guard relies on this). Warnings are advisory and intentionally excluded.
  const sorted = [...items].sort((a, b) => (a.itemRef < b.itemRef ? -1 : a.itemRef > b.itemRef ? 1 : 0));
  // dbDataModes is a client-built record (the wizard sends toggle order at plan time, item order at apply time) and
  // JSON.stringify keeps insertion order, so its keys are sorted before hashing. Byte-identical when it is absent.
  const hashedOptions = options.dbDataModes
    ? { ...options, dbDataModes: Object.fromEntries(Object.entries(options.dbDataModes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }
    : options;
  const planHash = createHash("sha256").update(JSON.stringify({ items: sorted, options: hashedOptions })).digest("hex").slice(0, 32);
  return { sourceKind: options.sourceKind, mode: options.mode ?? "copy", items, totals, warnings: fleet.warnings, planHash };
}

/**
 * Preview visibility for the project/environment tree (Dokploy): an INFO risk naming the target Tugra project +
 * environment a resource will land in. Derived only from the resource's projectRef/environmentRef and the
 * fleet's project names, so it is deterministic (planHash stays stable) and never a blocker. Absent for a source
 * with no tree (Coolify, local-docker) or a ref the fleet cannot name — those keep the single-environment path.
 */
function treeRisk(projects: ForeignProject[] | undefined, res: { projectRef?: string; environmentRef?: string }, code: string): ImportRisk | undefined {
  if (!res.projectRef || !res.environmentRef) return undefined;
  const project = projects?.find((p) => p.ref === res.projectRef);
  const env = project?.environments.find((e) => e.ref === res.environmentRef);
  if (!project || !env) return undefined;
  return { level: "info", code, message: `imports into project "${project.name}", environment "${env.name}" (created on the target team if missing, reused otherwise)` };
}

function planDatabase(db: ForeignDb, tree?: ImportRisk, volumeMode = false): ImportPlanItem {
  const risks: ImportRisk[] = [];
  if (tree) risks.push(tree);
  if (db.engine === "UNKNOWN") {
    risks.push({ level: "blocker", code: "db.engine.unknown", message: `cannot map database engine for "${db.name}"` });
  } else if (UNSUPPORTED_DB_IMPORT.has(db.engine)) {
    risks.push({ level: "blocker", code: "db.engine.noImport", message: `${db.engine} has no dump/restore path yet` });
  }
  if (db.engine === "MONGO") {
    risks.push({ level: "warn", code: "db.mongo.name", message: "name the target so its slug equals the source database name — mongorestore restores into the archive's DB names" });
  }
  for (const n of db.notCarried ?? []) risks.push({ level: n.level, code: `db.notCarried.${n.field}`, message: `${n.field}: ${n.reason}` });
  if (!db.version) risks.push({ level: "warn", code: "db.version.missing", message: "source version unknown — pin the target to the source's major version" });
  if (db.image) risks.push({ level: "info", code: "db.image.custom", message: `keeps custom image ${db.image}` });
  if (!db.credentials?.secretRef && !db.credentials?.username) {
    risks.push({ level: "warn", code: "db.creds.missing", message: "no source credentials found — dependent apps' DATABASE_URL must be rewritten manually" });
  }
  // Physical (volume) copy: Postgres only, and only when the exact source major + image are known (the gates re-prove
  // them against the real data directory at migrate time; these are the early, plan-time refusals).
  if (volumeMode) {
    if (db.engine !== "POSTGRES") {
      risks.push({ level: "blocker", code: "db.volume.engine", message: `volume copy is only offered for PostgreSQL, not ${db.engine}` });
    } else if (!db.version || !db.image) {
      risks.push({ level: "blocker", code: "db.volume.unknown", message: "volume copy needs the exact source image and PostgreSQL version, which the source did not report; use the logical dump" });
    } else {
      risks.push({ level: "info", code: "db.volume.locked", message: `volume copy locks the target to the source image ${db.image}, its PostgreSQL major ${db.version} and the carried database and user names (a physical copy only works with the same image, major and credentials)` });
    }
  }
  return {
    itemRef: ns("database", db.serverRef, db.sourceRef),
    kind: "database",
    name: db.name,
    proposed: { engine: db.engine, version: db.version ?? null, image: db.image ?? null, database: db.credentials?.database ?? null, ...(volumeMode ? { dataMode: "volume" } : {}) },
    risks,
    dependsOn: [],
  };
}

function planApp(app: ForeignApp, dbByRef: Map<string, ForeignDb>, volumesCarried: boolean, tree?: ImportRisk): ImportPlanItem {
  const risks: ImportRisk[] = [];
  if (tree) risks.push(tree);
  const build = mapBuildPack(app);
  if (build.note) risks.push({ level: "warn", code: "app.buildpack", message: build.note });

  // Un-importable: nothing to deploy from.
  if (build.source === "GIT" && !app.git) risks.push({ level: "blocker", code: "app.git.missing", message: "a Git build has no repository URL (e.g. a git-push-only source) — connect a repo or import as an image" });
  if (build.source === "IMAGE" && !app.image && app.imageOrigin === "local") risks.push({ level: "warn", code: "app.image.transfer", message: "image is local-only on the source — it must be shipped (docker save/load or a registry)" });
  if (build.source === "IMAGE" && !app.image && app.imageOrigin !== "local") risks.push({ level: "blocker", code: "app.image.missing", message: "nothing to deploy — no image and no git repository" });
  if (build.source === "COMPOSE" && !app.composeFile && !app.git?.url) risks.push({ level: "blocker", code: "app.compose.missing", message: "compose app has no compose file and no git source to import" });
  if ((build.source === "GIT" || build.source === "COMPOSE") && app.git?.provider === "github") risks.push({ level: "warn", code: "app.git.private", message: "GitHub source via the source PaaS's GitHub-App install: private repos are linked at apply to the connected GitHub/Gitea source that can actually see the repo; none or several => left unlinked and listed (connect one, then use Re-check or Link now)" });

  const domains = app.domains ?? [];
  if (domains.length > 1) risks.push({ level: "warn", code: "app.domain.multi", message: `${domains.length} domains — the first ("${domains[0].host}") is primary; add the rest after` });
  // What runCopyApp will actually declare (same mapper → the plan can't drift from the executor). null for
  // local-docker, which adopts in place and re-attaches the original named volumes by name (not via this mapper).
  const mappedVolumes = volumesCarried ? null : foreignAppToVolumes(app);
  const appVolumes = app.volumes ?? [];
  if (!volumesCarried && build.source === "COMPOSE" && appVolumes.length) {
    risks.push({ level: "info", code: "app.volume.compose", message: "volumes of a compose app live in its compose file; they are not declared separately and their data is not copied" });
  } else {
    // Only claim a volume is "declared" when the mapper actually declared one (carried = local-docker always
    // describes; non-carried only when ≥1 mount survived) — else app.volume.skipped carries the whole story.
    const declaredSome = !mappedVolumes || mappedVolumes.volumes.length > 0;
    if (declaredSome && appVolumes.some((v) => v.type === "bind")) risks.push({ level: "warn", code: "app.volume.bind", message: bindVolumeMessage(volumesCarried) });
    if (declaredSome && appVolumes.some((v) => v.type === "named")) risks.push({ level: "warn", code: "app.volume.named", message: namedVolumeMessage(volumesCarried) });
    if (mappedVolumes && mappedVolumes.skipped.length) {
      // sort() so the hash stays independent of the source's mount discovery order (planHash invariant).
      const reasons = [...new Set(mappedVolumes.skipped.map((s) => s.reason))].sort().join(", ");
      risks.push({ level: "warn", code: "app.volume.skipped", message: `${mappedVolumes.skipped.length} mount(s) not declared (${reasons}) — recreate them on the target manually if needed` });
    }
  }
  if (build.source === "COMPOSE") {
    const gitCompose = !!app.git?.url && !app.composeFile;
    if (gitCompose) {
      // A git-compose is NOT validated at import (there is no stored YAML) — it is cloned and validated at deploy.
      risks.push({ level: "info", code: "app.compose", message: "compose is cloned from git and validated at deploy (assertSafeCompose) — a service using host networking, privileged mode or a docker-socket bind will be rejected then" });
      if (!app.git?.composePath) risks.push({ level: "warn", code: "app.compose.path", message: "the compose file path is unknown — Tugra will look for docker-compose.yml at the repo root; set the compose path in the app's Git settings if the file is elsewhere" });
      const svcDomains = [...new Set((app.domains ?? []).map((d) => d.serviceRef).filter((s): s is string => !!s))];
      if (svcDomains.length) risks.push({ level: "warn", code: "app.compose.domains", message: `per-service domains are not carried for a git compose yet — after import, set each service's domain (source services: ${svcDomains.join(", ")})` });
    } else {
      risks.push({ level: "info", code: "app.compose", message: "the compose file is stored as-is and validated (assertSafeCompose) when the app is created; Coolify magic variables (SERVICE_*) are not rewritten for app composes. A compose that fails the gate fails this item." });
    }
  }
  if (app.privileged || app.mountsDockerSock) risks.push({ level: "warn", code: "app.privileged", message: "source uses privileged mode or mounts the docker socket — requires explicit acknowledgement to import" });
  if (app.installCommand) risks.push({ level: "warn", code: "app.installCommand", message: "source has an install command Tugra does not model — fold it into the build" });
  if ((app.env ?? []).some((e) => e.ref?.type === "vault" || e.ref?.type === "encrypted")) {
    risks.push({ level: "blocker", code: "app.env.unresolvable", message: "some env values are vault/encrypted references the source cannot expand — provide them at import time" });
  }
  if (app.envReport) risks.push(...envReportRisks(app.envReport));

  // Ordering: the app waits for its linked databases and its volumes. Volume refs are sorted + de-duped so the
  // item (hence planHash) is independent of the source's mount discovery order — the apply-time stale-guard
  // relies on two scans of an unchanged host hashing equal.
  const dependsOn = [
    ...(app.links ?? [])
      .filter((l) => l.kind === "database")
      .map((l) => ns("database", dbByRef.get(l.ref)?.serverRef ?? app.serverRef, l.ref)),
    ...[...new Set((app.volumes ?? []).map((v) => ns("volume", app.serverRef, volKey(v))))].sort(),
  ];

  return {
    itemRef: ns("app", app.serverRef, app.sourceRef),
    kind: "app",
    name: app.name,
    proposed: {
      source: build.source,
      buildType: build.buildType ?? null,
      image: app.image ?? null,
      git: app.git ?? null,
      domain: domains.find((d) => d.primary)?.host ?? domains[0]?.host ?? null,
      ports: app.ports ?? [],
      envCount: (app.env ?? []).length, // count only — values are never in the plan
      replicas: app.replicas ?? 1,
      templateSlug: app.templateSlug ?? null,
      ...(mappedVolumes ? { volumeMounts: mappedVolumes.volumes.length } : {}),
    },
    risks,
    dependsOn,
  };
}

/** Env risk codes. `unresolved` and `key.invalid` are ACKABLE blockers (see ImportApplySchema.acks); `tokenReadOnly` never is. */
export const ENV_RISK_UNRESOLVED = "app.env.unresolved";
export const ENV_RISK_INVALID = "app.env.key.invalid";
export const ENV_RISK_TOKEN_READ_ONLY = "app.env.tokenReadOnly";
export const ENV_RISK_PREVIEW = "app.env.preview";
export const ACKABLE_RISK_CODES: readonly string[] = [ENV_RISK_UNRESOLVED, ENV_RISK_INVALID];
const ENV_LIST_CAP = 40;

/** Names + reason codes only — NEVER values. Keys are already sorted and capped by buildEnvReport. */
const nameList = (names: string[]): string => (names.length > ENV_LIST_CAP ? `${names.slice(0, ENV_LIST_CAP).join(", ")} (+${names.length - ENV_LIST_CAP} more)` : names.join(", "));

/** Strict-env plan rows for a source that reports `envReport` (Coolify). Only called when the report exists, so a
 *  source without one (Dokploy/local) keeps its items — hence its planHash — byte-identical. */
function envReportRisks(r: NonNullable<ForeignApp["envReport"]>): ImportRisk[] {
  const out: ImportRisk[] = [];
  if (r.tokenReadOnly) {
    // One actionable row instead of one per variable. NOT ackable: without values there is nothing to carry.
    out.push({ level: "blocker", code: ENV_RISK_TOKEN_READ_ONLY, message: "the API token cannot read variable values; create a Coolify token with the read:sensitive ability and reconnect" });
  } else if (r.unresolved.length) {
    out.push({
      level: "blocker",
      code: ENV_RISK_UNRESOLVED,
      message: `${r.unresolved.length} variable(s) cannot be carried and will be missing in the new app: ${nameList(r.unresolved.map((u) => `${u.key} (${u.reason})`))}`,
    });
  }
  if (r.invalidKeys.length) {
    out.push({ level: "blocker", code: ENV_RISK_INVALID, message: `${r.invalidKeys.length} variable name(s) are not valid environment keys and will be skipped: ${nameList(r.invalidKeys)}` });
  }
  if (r.previewSkipped > 0) out.push({ level: "info", code: ENV_RISK_PREVIEW, message: `${r.previewSkipped} preview-environment variable(s) are not imported` });
  return out;
}

function bindVolumeMessage(carried: boolean): string {
  return carried
    ? "host bind-mounts are not carried over (only named volumes are re-attached); their data stays on the host"
    : "host bind-mounts are declared as EMPTY named volumes at the same container path; upload their DATA to the hub before the first deploy (tar the source folder + curl, up to the size cap; host file ownership is not preserved, larger folders are copied manually) — the source host folder itself is not mounted on the target";
}

function namedVolumeMessage(carried: boolean): string {
  return carried
    ? "named volume is re-attached to the adopted container by its original name on redeploy (data is not copied, and it is not removed with the app)"
    : "an EMPTY named volume is declared on the target app at the container path; upload its DATA to the hub before the first deploy (tar the source volume + curl, up to the size cap; larger volumes are copied manually) or the app starts empty";
}

function planVolume(vol: ForeignVolume, serverRef: string | undefined, carried: boolean): ImportPlanItem {
  // Per-volume item: whether a mount is actually DECLARED is decided per-app by the mapper and reported on the
  // owning app's item (app.volume.*). Here we only state the data-movement truth, which holds for every case
  // (app-owned or standalone, declared or skipped), so this item can never contradict the app item.
  const risks: ImportRisk[] = [];
  if (vol.type === "bind") {
    risks.push({ level: "warn", code: "volume.bind", message: carried
      ? "host bind-mount is not carried over (only named volumes are re-attached); its data stays on the host"
      : "host bind-mount — the source host folder is not mounted on the target; copy its data to the target before the first deploy (ownership not preserved)" });
  }
  if (vol.type === "named") {
    risks.push({ level: "warn", code: "volume.named", message: carried
      ? namedVolumeMessage(true)
      : "named volume — its data is not moved automatically; copy it to the target before the first deploy (upload a declared app volume to the hub, else copy it manually) or the app starts empty" });
  }
  return {
    itemRef: ns("volume", serverRef, volKey(vol)),
    kind: "volume",
    name: vol.name ?? vol.mountPath,
    proposed: { mountPath: vol.mountPath, type: vol.type, owner: vol.ownerRef ?? null },
    risks,
    dependsOn: [],
  };
}


// ── Services (Coolify stacks → ONE stopped Tugra COMPOSE app each) ───────────────────────────────────────────────

/** Everything the plan, the preflight and the coverage report derive from one service, computed in one place so the
 *  three can never drift. Pure; plan time (no secrets), so `bundle` is never passed. */
export interface ServiceAnalysis {
  itemRef: string;
  result: ServiceTransformResult | undefined; // undefined when the source gave no compose
  risks: ImportRisk[];
  verdict: "importable" | "partial" | "skipped";
  compat: "template" | "passthrough" | "blocked";
  /** A one-sentence, fixed-text reason for a skipped service. */
  skipReason?: string;
}

const GATE_RISK: Record<string, { code: string; message: string }> = {
  "compose-unparsed": { code: "service.compose.unparsed", message: "the source's compose file could not be parsed as a compose document" },
  "compose-too-large": { code: "service.compose.unparsed", message: "the source's compose file is larger than the 256 KiB import limit" },
  "service-name": { code: "service.compose.unparsed", message: "a compose service has a name Tugra cannot use" },
  "volume-name": { code: "service.volume.name", message: "a named volume has a name the data step cannot address (lowercase letters, digits, - and _ only, at most 41 characters)" },
};

export function analyzeService(svc: ForeignService): ServiceAnalysis {
  const itemRef = ns("service", svc.serverRef, svc.sourceRef);
  const risks: ImportRisk[] = [];
  const tplMatch = !!svc.templateSlug && Object.prototype.hasOwnProperty.call(TEMPLATES, svc.templateSlug);
  if (!svc.composeFile) {
    risks.push({ level: "blocker", code: "service.compose.unavailable", message: "the source did not return this service's compose file (the token may need read:sensitive)" });
    return { itemRef, result: undefined, risks, verdict: "skipped", compat: "blocked", skipReason: "the source did not return the service's compose file" };
  }
  const r = transformServiceCompose({ svc, raw: svc.composeFile });
  const names = (xs: string[]) => xs.join(", ");

  if (r.gate !== "ok") {
    const known = GATE_RISK[r.gate.code];
    if (known) risks.push({ level: "blocker", code: known.code, message: known.message });
    else risks.push({ level: "blocker", code: "service.gate", message: `the compose uses something Tugra's safety gate refuses (${r.gate.code}${r.gate.detail ? `: ${r.gate.detail}` : ""}); it is never carried or overridden` });
    return { itemRef, result: r, risks, verdict: "skipped", compat: "blocked", skipReason: "the compose is refused by the safety gate" };
  }
  if (r.membersKept.length === 0) {
    risks.push({ level: "info", code: "service.type.unsupported", message: `not imported: every member needs something Tugra never carries (${names(r.membersDropped.map((m) => `${m.name}: ${m.reason}`))}) — Tugra monitors the host itself` });
    return { itemRef, result: r, risks, verdict: "skipped", compat: "blocked", skipReason: "every member needs something Tugra never carries" };
  }
  if (r.membersDropped.length) {
    risks.push({ level: "warn", code: "service.member.dropped", message: `imported without: ${names(r.membersDropped.map((m) => `${m.name} (${m.reason})`))}` });
  }
  const hostBinds = r.volumes.filter((v) => v.origin === "host-bind");
  if (hostBinds.length) {
    risks.push({ level: "warn", code: "service.volume.hostbind", message: `host folder bind(s) are carried as named volume(s) (${names(hostBinds.map((v) => v.key))}); the host folder itself is not mounted on the target` });
  }
  const copyVols = r.volumes.filter((v) => v.policy === "copy");
  if (copyVols.length) {
    risks.push({ level: "warn", code: "service.volume.size-unknown", message: `the size of ${names(copyVols.map((v) => v.key))} is not measured at plan time; a volume over the hub-staging cap is copied by hand` });
  }
  if (r.floating.length) {
    risks.push({ level: "warn", code: "service.image.floating", message: `floating image tag on ${names(r.floating)}: pin it to the version the source runs, or the registry's current latest is pulled (a data directory can be version-bound)` });
  }
  if (r.neededFiles.length) {
    risks.push({ level: "warn", code: "service.files.needed", message: `${r.neededFiles.length} config file(s) are carried only if the token can read them (${names(r.neededFiles)}); without them the service is not imported` });
  }
  if (r.volumes.some((v) => v.dataPlane === "manual-large")) {
    risks.push({ level: "warn", code: "service.data.manual-large", message: "a volume is over the hub-staging cap: copy it with the big-volume pipeline or by hand" });
  }
  const skipVols = r.volumes.filter((v) => v.policy === "skip");
  if (skipVols.length) {
    risks.push({ level: "warn", code: "service.data.not-carried", message: `the data of ${names(skipVols.map((v) => v.key))} is intentionally not carried (Compose creates it empty on the first deploy)` });
  }
  if (r.hold) {
    risks.push({ level: "warn", code: "service.hold", message: "created stopped and never deployed by the import: running it next to the source would split live traffic. Stop the source and repoint its routes by hand first" });
  }
  risks.push({ level: "warn", code: "service.deploy.manual", message: "created stopped; nothing is deployed by the import. Copy the data (if any), then deploy it yourself" });
  if (r.domains.length === 0 && !r.hold) {
    risks.push({ level: "warn", code: "service.reach", message: "no domain is mapped: other apps keep reaching it by its old internal host until they are repointed (the app joins a private network instead of a public domain)" });
  }
  if (r.dropped.some((d) => d.field.endsWith(".container_name"))) {
    risks.push({ level: "warn", code: "service.container-name", message: "container names are not carried; the compose service key is the DNS name inside the app" });
  }
  if (r.unverifiedKeys.length) {
    risks.push({ level: "info", code: "service.secrets.unverified", message: `${r.unverifiedKeys.length} variable(s) are read from the source when you apply (never shown here)` });
  }
  return { itemRef, result: r, risks, verdict: r.verdict, compat: tplMatch ? "template" : "passthrough" };
}

function planService(svc: ForeignService): ImportPlanItem {
  const a = analyzeService(svc);
  const r = a.result;
  const keptSet = new Set(r?.membersKept ?? []);
  return {
    itemRef: a.itemRef,
    kind: "service",
    name: svc.name,
    proposed: {
      name: svc.name,
      source: "COMPOSE",
      members: [...(svc.members ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((m) => ({ name: m.name, kind: m.kind, kept: keptSet.has(m.name) })),
      volumes: (r?.volumes ?? []).map((v) => ({ key: v.key, origin: v.origin, policy: v.policy, dataPlane: v.dataPlane })),
      serviceDomains: (r?.domains ?? []).map((d) => ({ service: d.service, host: d.hostname, port: d.port })),
      deployed: false,
      verdict: a.verdict,
      compat: a.compat,
      templateSlug: svc.templateSlug ?? null,
      imageFloating: r?.floating ?? [],
      hold: r?.hold ?? false,
    },
    risks: a.risks,
    dependsOn: [],
  };
}

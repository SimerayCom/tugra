import { createHash } from "node:crypto";
import type {
  ForeignApp,
  ForeignDb,
  ForeignFleet,
  ForeignVolume,
  ImportOptions,
  ImportPlan,
  ImportPlanItem,
  ImportRisk,
} from "./foreign-fleet";
import { mapBuildPack } from "./buildpack-map";

const UNSUPPORTED_DB_IMPORT = new Set(["LIBSQL"]); // no logical dump/restore pipeline yet (volume-copy only)

const ns = (kind: string, serverRef: string | undefined, ref: string): string => `${kind}:${serverRef ?? "_"}:${ref}`;
const volKey = (v: ForeignVolume): string => v.name ?? v.hostPath ?? v.mountPath;

/**
 * Pure, deterministic dry-run: turn a discovered {@link ForeignFleet} into an {@link ImportPlan} — a preview
 * of the Tugra resources an import would create, with per-item risks (lossy/dropped/blocking) and a
 * dependency order (databases and volumes before the apps that use them). No I/O, no secrets, no persistence.
 */
export function planImport(fleet: ForeignFleet, options: ImportOptions): ImportPlan {
  const dbByRef = new Map(fleet.databases.map((d) => [d.sourceRef, d]));

  const dbItems = fleet.databases.map((db) => planDatabase(db));

  // Volumes: standalone + app-owned, deduped by their namespaced itemRef.
  const volItems = new Map<string, ImportPlanItem>();
  for (const v of fleet.volumes) {
    const it = planVolume(v, undefined);
    volItems.set(it.itemRef, it);
  }
  for (const app of fleet.apps) {
    for (const v of app.volumes ?? []) {
      const it = planVolume(v, app.serverRef);
      if (!volItems.has(it.itemRef)) volItems.set(it.itemRef, it);
    }
  }

  const appItems = fleet.apps.map((app) => planApp(app, dbByRef));

  const items = [...dbItems, ...volItems.values(), ...appItems];
  const totals = {
    apps: fleet.apps.length,
    databases: fleet.databases.length,
    volumes: volItems.size,
    blockers: items.reduce((n, it) => n + it.risks.filter((r) => r.level === "blocker").length, 0),
  };
  // Deterministic: depends only on the plan content + options (no time/random). Warnings are advisory and
  // intentionally excluded from the hash — they must not perturb the executor's confirmToken.
  const planHash = createHash("sha256").update(JSON.stringify({ items, options })).digest("hex").slice(0, 32);
  return { sourceKind: options.sourceKind, mode: options.mode ?? "copy", items, totals, warnings: fleet.warnings, planHash };
}

function planDatabase(db: ForeignDb): ImportPlanItem {
  const risks: ImportRisk[] = [];
  if (db.engine === "UNKNOWN") {
    risks.push({ level: "blocker", code: "db.engine.unknown", message: `cannot map database engine for "${db.name}"` });
  } else if (UNSUPPORTED_DB_IMPORT.has(db.engine)) {
    risks.push({ level: "blocker", code: "db.engine.noImport", message: `${db.engine} has no dump/restore path yet` });
  }
  if (db.engine === "MONGO") {
    risks.push({ level: "warn", code: "db.mongo.name", message: "name the target so its slug equals the source database name — mongorestore restores into the archive's DB names" });
  }
  if (!db.version) risks.push({ level: "warn", code: "db.version.missing", message: "source version unknown — pin the target to the source's major version" });
  if (db.image) risks.push({ level: "info", code: "db.image.custom", message: `keeps custom image ${db.image}` });
  if (!db.credentials?.secretRef && !db.credentials?.username) {
    risks.push({ level: "warn", code: "db.creds.missing", message: "no source credentials found — dependent apps' DATABASE_URL must be rewritten manually" });
  }
  return {
    itemRef: ns("database", db.serverRef, db.sourceRef),
    kind: "database",
    name: db.name,
    proposed: { engine: db.engine, version: db.version ?? null, image: db.image ?? null, database: db.credentials?.database ?? null },
    risks,
    dependsOn: [],
  };
}

function planApp(app: ForeignApp, dbByRef: Map<string, ForeignDb>): ImportPlanItem {
  const risks: ImportRisk[] = [];
  const build = mapBuildPack(app);
  if (build.note) risks.push({ level: "warn", code: "app.buildpack", message: build.note });

  // Un-importable: nothing to deploy from.
  if (build.source === "GIT" && !app.git) risks.push({ level: "blocker", code: "app.git.missing", message: "a Git build has no repository URL (e.g. a git-push-only source) — connect a repo or import as an image" });
  if (build.source === "IMAGE" && !app.image && app.imageOrigin === "local") risks.push({ level: "warn", code: "app.image.transfer", message: "image is local-only on the source — it must be shipped (docker save/load or a registry)" });
  if (build.source === "IMAGE" && !app.image && app.imageOrigin !== "local") risks.push({ level: "blocker", code: "app.image.missing", message: "nothing to deploy — no image and no git repository" });
  if (build.source === "COMPOSE" && !app.composeFile) risks.push({ level: "blocker", code: "app.compose.missing", message: "compose app has no compose file to import" });

  const domains = app.domains ?? [];
  if (domains.length > 1) risks.push({ level: "warn", code: "app.domain.multi", message: `${domains.length} domains — the first ("${domains[0].host}") is primary; add the rest after` });
  if ((app.volumes ?? []).some((v) => v.type === "bind")) risks.push({ level: "warn", code: "app.volume.bind", message: "host bind-mounts are converted to named volumes; data must be copied manually" });
  if (build.source === "COMPOSE") risks.push({ level: "info", code: "app.compose", message: "compose file is rewritten (magic vars) and validated (assertSafeCompose) on import" });
  if (app.privileged || app.mountsDockerSock) risks.push({ level: "warn", code: "app.privileged", message: "source uses privileged mode or mounts the docker socket — requires explicit acknowledgement to import" });
  if (app.installCommand) risks.push({ level: "warn", code: "app.installCommand", message: "source has an install command Tugra does not model — fold it into the build" });
  if ((app.env ?? []).some((e) => e.ref?.type === "vault" || e.ref?.type === "encrypted")) {
    risks.push({ level: "blocker", code: "app.env.unresolvable", message: "some env values are vault/encrypted references the source cannot expand — provide them at import time" });
  }
  if (app.serviceRef) risks.push({ level: "info", code: "app.service.member", message: "part of a multi-container service — imported with its stack" });

  // Ordering: the app waits for its linked databases and its volumes.
  const dependsOn = [
    ...(app.links ?? [])
      .filter((l) => l.kind === "database")
      .map((l) => ns("database", dbByRef.get(l.ref)?.serverRef ?? app.serverRef, l.ref)),
    ...(app.volumes ?? []).map((v) => ns("volume", app.serverRef, volKey(v))),
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
    },
    risks,
    dependsOn,
  };
}

function planVolume(vol: ForeignVolume, serverRef: string | undefined): ImportPlanItem {
  return {
    itemRef: ns("volume", serverRef, volKey(vol)),
    kind: "volume",
    name: vol.name ?? vol.mountPath,
    proposed: { mountPath: vol.mountPath, type: vol.type, owner: vol.ownerRef ?? null },
    risks:
      vol.type === "bind"
        ? [{ level: "warn", code: "volume.bind", message: "host bind-mount — converted to a named volume; data copied manually" }]
        : [],
    dependsOn: [],
  };
}

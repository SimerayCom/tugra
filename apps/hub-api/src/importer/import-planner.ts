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
import { foreignAppToVolumes } from "./apply-map";

// Engines whose CONFIG cannot be imported (the planner emits a blocker; the executor skips the item, so NO
// target database is created). Exported so the preflight classifies them identically — one source, no drift.
export const UNSUPPORTED_DB_IMPORT = new Set(["LIBSQL"]); // no logical dump/restore pipeline yet (volume-copy only)

const ns = (kind: string, serverRef: string | undefined, ref: string): string => `${kind}:${serverRef ?? "_"}:${ref}`;
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

  const dbItems = fleet.databases.map((db) => planDatabase(db));

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

  const appItems = fleet.apps.map((app) => planApp(app, dbByRef, carried));

  const items = [...dbItems, ...volItems.values(), ...appItems];
  const totals = {
    apps: fleet.apps.length,
    databases: fleet.databases.length,
    volumes: volItems.size,
    blockers: items.reduce((n, it) => n + it.risks.filter((r) => r.level === "blocker").length, 0),
  };
  // Deterministic: depends only on the plan content + options (no time/random). Items are sorted by their
  // itemRef first, so the hash is independent of discovery order (two scans of an unchanged host hash equal
  // — the apply-time stale-guard relies on this). Warnings are advisory and intentionally excluded.
  const sorted = [...items].sort((a, b) => (a.itemRef < b.itemRef ? -1 : a.itemRef > b.itemRef ? 1 : 0));
  const planHash = createHash("sha256").update(JSON.stringify({ items: sorted, options })).digest("hex").slice(0, 32);
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

function planApp(app: ForeignApp, dbByRef: Map<string, ForeignDb>, volumesCarried: boolean): ImportPlanItem {
  const risks: ImportRisk[] = [];
  const build = mapBuildPack(app);
  if (build.note) risks.push({ level: "warn", code: "app.buildpack", message: build.note });

  // Un-importable: nothing to deploy from.
  if (build.source === "GIT" && !app.git) risks.push({ level: "blocker", code: "app.git.missing", message: "a Git build has no repository URL (e.g. a git-push-only source) — connect a repo or import as an image" });
  if (build.source === "IMAGE" && !app.image && app.imageOrigin === "local") risks.push({ level: "warn", code: "app.image.transfer", message: "image is local-only on the source — it must be shipped (docker save/load or a registry)" });
  if (build.source === "IMAGE" && !app.image && app.imageOrigin !== "local") risks.push({ level: "blocker", code: "app.image.missing", message: "nothing to deploy — no image and no git repository" });
  if (build.source === "COMPOSE" && !app.composeFile && !app.git?.url) risks.push({ level: "blocker", code: "app.compose.missing", message: "compose app has no compose file and no git source to import" });
  if ((build.source === "GIT" || build.source === "COMPOSE") && app.git?.provider === "github") risks.push({ level: "warn", code: "app.git.private", message: "GitHub source via the source PaaS's GitHub-App install — if the repo is private, Tugra links it to your connected GitHub App on import ONLY when your team has exactly one installed; with none or several, connect/pick one in the app's Git settings before the first deploy or the clone fails" });

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
      risks.push({ level: "info", code: "app.compose", message: "compose file is rewritten (magic vars) and validated (assertSafeCompose) on import" });
    }
  }
  if (app.privileged || app.mountsDockerSock) risks.push({ level: "warn", code: "app.privileged", message: "source uses privileged mode or mounts the docker socket — requires explicit acknowledgement to import" });
  if (app.installCommand) risks.push({ level: "warn", code: "app.installCommand", message: "source has an install command Tugra does not model — fold it into the build" });
  if ((app.env ?? []).some((e) => e.ref?.type === "vault" || e.ref?.type === "encrypted")) {
    risks.push({ level: "blocker", code: "app.env.unresolvable", message: "some env values are vault/encrypted references the source cannot expand — provide them at import time" });
  }
  if (app.serviceRef) risks.push({ level: "info", code: "app.service.member", message: "part of a multi-container service — imported with its stack" });

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

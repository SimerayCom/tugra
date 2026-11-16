import type { ForeignApp, ForeignFleet, ImportCoverage, ImportCoverageApp, ImportOptions } from "./foreign-fleet";
import { foreignAppToIngressPlan, foreignAppToPostCreateConfig } from "./apply-map";
import { why } from "./reason";
import { mapBuildPack } from "./buildpack-map";
import { analyzeService, ns } from "./import-planner";
import { isSshGitUrl } from "../deploy/deploy-script";
import { isMinioService } from "./preflight";
import { serviceVolumeStreamable, validServiceMountPath } from "./volume-stream/vx-targets";

type Entry = ImportCoverageApp["notCarried"][number];

/** Post-create fields that deserve a review (a behavioural difference after import); everything else is a note. */
const WARN_POST_CREATE = new Set(["dockerBuildTarget", "limits", "watchPaths", "containerCommand", "triggerType"]);

/**
 * Pure, presence-only "what is not carried over" report for the review screen. It reuses the SAME mappers the
 * executor runs (so the plan cannot drift from the apply) but never reads the source's secret text: label and
 * Dockerfile text are only known by their discover-time markers. Field NAMES + fixed reasons only. Advisory: NOT
 * part of planHash and not consumed by the executor. `undefined` for local-docker (adopts in place) or when empty.
 */
export function buildCoverage(fleet: ForeignFleet, options: ImportOptions): ImportCoverage | undefined {
  if (options.sourceKind === "local-docker") return undefined;
  const apps: ImportCoverageApp[] = [];
  for (const app of fleet.apps) {
    const notCarried = coverageFor(app);
    if (notCarried.length) apps.push({ itemRef: ns("app", app.serverRef, app.sourceRef), name: app.name, notCarried });
  }
  // Services: what each one does not carry as-is (dropped members, stripped container names / ports / labels, host-bind
  // rewrites, config files, volumes whose data is skipped). Names + fixed reasons only. Advisory: not hashed.
  for (const svc of fleet.services ?? []) {
    const a = analyzeService(svc);
    const r = a.result;
    if (!r) continue;
    const entries: Entry[] = r.dropped.map((d) => ({ field: d.field, reason: d.reason, level: d.level }));
    for (const v of r.volumes) if (v.policy === "empty") entries.push({ field: `volume:${v.key}`, reason: "starts empty on the target (coordination state is rebuilt)", level: "info" });
    // R39/R53: a volume the import means to copy but the streamed lane cannot carry (its name or mount is unusable) is said so at plan time
    // an object store's volume is never streamed (the buckets move through Object migration): it is not "unusable", see the objectData row
    for (const v of r.volumes) if (!isMinioService(svc) && v.policy === "copy" && !serviceVolumeStreamable({ key: v.key, policy: v.policy, mountPath: v.mounts.find((m) => validServiceMountPath(m.path))?.path ?? null })) entries.push({ field: `volume:${v.key}`, reason: "its data cannot ride the streamed volume copy (the volume name or mount point is not usable); copy it by hand", level: "warn" });
    // R33: an object store's buckets are never copied with the service: Object migration moves them
    if (isMinioService(svc)) entries.push({ field: "objectData", reason: "the store's data volume is not streamed with the service; its buckets move only through an Object migration attached to the run (or keep the store external)", level: "warn" });
    for (const f of r.neededFiles) entries.push({ field: `file:${f}`, reason: "config file needed from the source; the service is not imported without it", level: "warn" });
    if (r.configMounts.length) entries.push({ field: "configMounts", reason: `${r.configMounts.length} config file(s) are carried as Tugra config mounts`, level: "info" });
    if (!entries.length) continue;
    entries.sort((x, y) => (x.level === y.level ? (x.field < y.field ? -1 : x.field > y.field ? 1 : 0) : x.level === "warn" ? -1 : 1));
    apps.push({ itemRef: a.itemRef, name: svc.name, notCarried: entries });
  }
  const env = envCoverage(fleet);
  const git = options.sourceKind === "coolify" ? gitCoverage(fleet) : undefined; // other sources keep their output byte-identical
  if (!apps.length && !env && !git) return undefined;
  apps.sort((a, b) => (a.itemRef < b.itemRef ? -1 : a.itemRef > b.itemRef ? 1 : 0));
  return { apps, ...(env ? { env } : {}), ...(git ? { git } : {}) };
}

const byRef = (a: { itemRef: string }, b: { itemRef: string }): number => (a.itemRef < b.itemRef ? -1 : a.itemRef > b.itemRef ? 1 : 0);

/** Presence-only env section (key NAMES + reason codes; never values). Only for apps whose source reported an envReport
 *  (Coolify), and only when something is worth saying — a clean app is not listed. */
function envCoverage(fleet: ForeignFleet): NonNullable<ImportCoverage["env"]> | undefined {
  const apps = fleet.apps
    .filter((a) => a.envReport && (a.envReport.unresolved.length || a.envReport.invalidKeys.length || a.envReport.previewSkipped || a.envReport.tokenReadOnly))
    .map((a) => ({
      itemRef: ns("app", a.serverRef, a.sourceRef),
      name: a.name,
      unresolved: a.envReport!.unresolved.map((u) => ({ key: u.key, reason: u.reason })),
      invalidKeys: a.envReport!.invalidKeys,
      previewSkipped: a.envReport!.previewSkipped,
      tokenReadOnly: a.envReport!.tokenReadOnly,
    }))
    .sort(byRef);
  return apps.length ? { apps } : undefined;
}

/** Repo URL shapes across the apps (counts only). Link status needs the target team and is resolved by /import/git-links. */
function gitCoverage(fleet: ForeignFleet): NonNullable<ImportCoverage["git"]> | undefined {
  let apps = 0;
  let ssh = 0;
  let githubApp = 0;
  for (const a of fleet.apps) {
    const url = a.git?.url;
    if (!url) continue;
    apps++;
    if (isSshGitUrl(url)) ssh++;
    if (a.git?.provider === "github") githubApp++;
  }
  return apps ? { apps, https: apps - ssh, ssh, githubApp } : undefined;
}

function coverageFor(app: ForeignApp): Entry[] {
  const all: Entry[] = [];
  for (const u of foreignAppToPostCreateConfig(app).unmapped) all.push({ ...u, level: WARN_POST_CREATE.has(u.field) ? "warn" : "info" });
  for (const u of foreignAppToIngressPlan(app).unmapped) all.push({ ...u, level: u.field.startsWith("basicAuth") ? "warn" : "info" });
  if (app.replicas !== undefined && app.replicas > 1) all.push({ field: "replicas", ...why("replicas"), level: "info" });
  all.push(...(app.notCarried ?? []));
  const isCompose = mapBuildPack(app).source === "COMPOSE";
  if (app.sourceExtras?.labels) {
    all.push(
      isCompose
        ? { field: "customLabels", level: "info", ...why("labels_compose") }
        : { field: "customLabels", level: "info", ...why("custom_labels_deferred") },
    );
  }
  if (app.sourceExtras?.dockerfile && app.git?.url && !isCompose) {
    all.push({ field: "inlineDockerfile", level: "info", ...why("dockerfile_deferred") });
  }
  // De-duplicate by field (first wins), then order deterministically: warn first, then field name.
  const seen = new Set<string>();
  const out = all.filter((e) => (seen.has(e.field) ? false : (seen.add(e.field), true)));
  out.sort((a, b) => (a.level === b.level ? (a.field < b.field ? -1 : a.field > b.field ? 1 : 0) : a.level === "warn" ? -1 : 1));
  return out;
}

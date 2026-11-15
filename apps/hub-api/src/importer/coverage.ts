import type { ForeignApp, ForeignFleet, ImportCoverage, ImportCoverageApp, ImportOptions } from "./foreign-fleet";
import { foreignAppToIngressPlan, foreignAppToPostCreateConfig } from "./apply-map";
import { why } from "./reason";
import { mapBuildPack } from "./buildpack-map";
import { ns } from "./import-planner";
import { isSshGitUrl } from "../deploy/deploy-script";

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

import type { ForeignApp, ForeignFleet, ImportCoverage, ImportCoverageApp, ImportOptions } from "./foreign-fleet";
import { foreignAppToIngressPlan, foreignAppToPostCreateConfig } from "./apply-map";
import { why } from "./reason";
import { mapBuildPack } from "./buildpack-map";
import { ns } from "./import-planner";

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
  if (!apps.length) return undefined;
  apps.sort((a, b) => (a.itemRef < b.itemRef ? -1 : a.itemRef > b.itemRef ? 1 : 0));
  return { apps };
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

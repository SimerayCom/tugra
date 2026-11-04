import { MIGRATOR_ENGINES } from "./migrator-recipe";
import { UNSUPPORTED_DB_IMPORT } from "./import-planner";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "./migration-staging";
import type { DbDataPlane, ForeignFleet, ImportOptions, ImportPreflight } from "./foreign-fleet";

const DEFAULT_CAP_MIB = Math.round(DEFAULT_MAX_ARTIFACT_BYTES / (1024 * 1024));

/**
 * How a database will migrate. Engine classes come from ONE source each: the planner's config-blocker set
 * (UNSUPPORTED_DB_IMPORT) and the migrator's one-click engine set (MIGRATOR_ENGINES).
 *  - blocked: config can't be imported at all → the plan blocks it and NO target database is created.
 *  - one-click: the migrator streams a logical dump/restore (run on the source host; per-DB size cap).
 *  - manual: config imports, but the data has no automated dump yet → dump & restore it by hand.
 */
export function classifyDbDataPlane(engine: string): { dataPlane: DbDataPlane; reason: string } {
  if (engine === "UNKNOWN") {
    return { dataPlane: "blocked", reason: "engine not recognized — the plan blocks it and no target database is created" };
  }
  if (UNSUPPORTED_DB_IMPORT.has(engine)) {
    return { dataPlane: "blocked", reason: "no import path yet — recreate it manually; the plan creates no target database" };
  }
  if ((MIGRATOR_ENGINES as string[]).includes(engine)) {
    return {
      dataPlane: "one-click",
      reason: `migrator-assisted: run the migrator on the source host to stream the dump (per-database ~${DEFAULT_CAP_MIB} MiB cap by default)`,
    };
  }
  return { dataPlane: "manual", reason: "config imports, but the data has no automated dump yet — dump and restore it manually" };
}

/**
 * Build the advisory preflight for a discovered fleet: per-DB data-movement class, the services the plan does
 * NOT import (so they are never a silent drop), and the volume-data caveat. Pure and secret-free.
 */
export function buildPreflight(fleet: ForeignFleet, options: ImportOptions): ImportPreflight {
  const carried = options.sourceKind === "local-docker"; // adopts in place; volumes re-attach, data not copied

  const databases = fleet.databases.map((d) => {
    const c = classifyDbDataPlane(d.engine);
    return { name: d.name, engine: d.engine, dataPlane: c.dataPlane, reason: c.reason };
  });

  const services = fleet.services.map((s) => ({
    name: s.name,
    members: s.memberApps.length + s.memberDbs.length,
    note: "service stack (compose / one-click) — not imported yet; recreate it on Tugra and copy its volume data",
  }));

  const appsWithVolumeData = carried ? 0 : fleet.apps.filter((a) => (a.volumes ?? []).length > 0).length;

  return {
    databases,
    services,
    appsWithVolumeData,
    volumeDataNote: appsWithVolumeData > 0
      ? "named/bind volume DATA is not copied by this import — copy it to the target before cutover or the app starts empty"
      : undefined,
  };
}

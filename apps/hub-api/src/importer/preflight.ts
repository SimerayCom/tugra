import { MIGRATOR_ENGINES } from "./migrator-recipe";
import { UNSUPPORTED_DB_IMPORT } from "./import-planner";
import { foreignAppToVolumes } from "./apply-map";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "./migration-staging";
import { maxVolumeBytes } from "./migration-volume";
import type { DbDataPlane, ForeignApp, ForeignFleet, ImportOptions, ImportPreflight, VolumeDataPlane } from "./foreign-fleet";

const DEFAULT_CAP_MIB = Math.round(DEFAULT_MAX_ARTIFACT_BYTES / (1024 * 1024));

// Mirrors apply-map's canonMountPath so a type lookup matches the mapper's declared path exactly.
const canonMount = (raw?: string): string => (raw ?? "").trim().replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");

type VolumeRow = NonNullable<ImportPreflight["volumes"]>[number];

/**
 * Per-app-volume data-movement rows. Declared-eligible mounts are `hub-staged` (or `manual-large` when a
 * supplied inventory measures them over the live cap); skipped mounts carry their skip reason as `manual`.
 * `inventory` maps `"<appName>:<containerPath>"` → compressed bytes; it is omitted at plan time (the Go
 * `--inventory` producer is deferred), so an eligible mount is size-unmeasured, never assumed small.
 */
function buildVolumeRows(apps: ForeignApp[], inventory: ReadonlyMap<string, number> | undefined, cap: number, capMiB: number): VolumeRow[] {
  const rows: VolumeRow[] = [];
  for (const app of apps) {
    if ((app.volumes ?? []).length === 0) continue;
    const mapped = foreignAppToVolumes(app);
    for (const v of mapped.volumes) {
      const isBind = (app.volumes ?? []).some((fv) => fv.type === "bind" && canonMount(fv.mountPath) === v.path);
      const type: "named" | "bind" = isBind ? "bind" : "named";
      const ownerNote = isBind ? "; host file ownership is not preserved" : "";
      const size = inventory?.get(`${app.name}:${v.path}`);
      let dataPlane: VolumeDataPlane;
      let reason: string;
      if (size === undefined) {
        dataPlane = "hub-staged";
        reason = `upload its data to the hub before the first deploy (tar the source volume + curl), up to ~${capMiB} MiB${ownerNote}`;
      } else if (size <= cap) {
        dataPlane = "hub-staged";
        reason = `~${Math.round(size / (1024 * 1024))} MiB — upload it to the hub before the first deploy (within the ~${capMiB} MiB cap)${ownerNote}`;
      } else {
        dataPlane = "manual-large";
        reason = `~${Math.round(size / (1024 * 1024))} MiB exceeds the ~${capMiB} MiB cap — copy it manually (tar + rsync/scp); do not raise the cap`;
      }
      rows.push({ app: app.name, mountPath: v.path, type, dataPlane, reason });
    }
    for (const s of mapped.skipped) {
      rows.push({ app: app.name, mountPath: s.mountPath, dataPlane: "manual", reason: `${s.reason} — recreate/copy it manually if needed` });
    }
  }
  return rows;
}

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
export function buildPreflight(fleet: ForeignFleet, options: ImportOptions, inventory?: ReadonlyMap<string, number>): ImportPreflight {
  const carried = options.sourceKind === "local-docker"; // adopts in place; volumes re-attach, data not copied

  const databases = fleet.databases.map((d) => {
    const c = classifyDbDataPlane(d.engine);
    return { name: d.name, engine: d.engine, dataPlane: c.dataPlane, reason: c.reason };
  });

  const services = fleet.services.map((s) => ({
    name: s.name,
    members: s.memberApps.length + s.memberDbs.length,
    note: "service stack (compose / one-click) — not imported yet; recreate it on Tugra and copy its volume data manually (rsync; quiesce the source first)",
  }));

  const appsWithVolumeData = carried ? 0 : fleet.apps.filter((a) => (a.volumes ?? []).length > 0).length;
  // Does ANY app actually get an empty volume declared? (A compose-only / all-skipped fleet declares none, so the
  // note must not claim "declared" in that case.)
  const appsDeclaringVolumes = carried ? 0 : fleet.apps.filter((a) => foreignAppToVolumes(a).volumes.length > 0).length;

  const cap = maxVolumeBytes();
  const capMiB = Math.round(cap / (1024 * 1024));
  const volumes = carried ? [] : buildVolumeRows(fleet.apps, inventory, cap, capMiB);

  return {
    databases,
    services,
    appsWithVolumeData,
    volumeDataNote:
      appsWithVolumeData === 0
        ? undefined
        : appsDeclaringVolumes > 0
          ? `empty volumes are declared on the new apps; upload their DATA to the hub before the first deploy (tar each source volume and curl it to the migration endpoint, up to ~${capMiB} MiB per volume; file ownership is not preserved, and a live tar is not crash-consistent — stop the source app first). Larger volumes are copied manually, or the app starts empty`
          : `these volumes are compose-managed or skipped (not declared on the target) — recreate and copy their DATA manually before the first deploy or the app starts empty`,
    ...(volumes.length ? { volumes } : {}),
  };
}

import { MIGRATOR_ENGINES } from "./migrator-recipe";
import { UNSUPPORTED_DB_IMPORT, analyzeService } from "./import-planner";
import { foreignAppToVolumes } from "./apply-map";
import { gitUrlHost } from "../deploy/deploy-script";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "./migration-staging";
import { maxVolumeBytes } from "./migration-volume";
import type { DbDataPlane, ForeignApp, ForeignFleet, ImportCutoverHint, ImportOptions, ImportPreflight, VolumeDataPlane } from "./foreign-fleet";
import { counterpartOf, isGeneratedHost } from "../cutover/cutover.logic";

const DEFAULT_CAP_MIB = Math.round(DEFAULT_MAX_ARTIFACT_BYTES / (1024 * 1024));

// Mirrors apply-map's canonMountPath so a type lookup matches the mapper's declared path exactly.
const canonMount = (raw?: string): string => (raw ?? "").trim().replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");

/** A MinIO object-store service: by its one-click template slug, or by a MinIO image in its compose file. */
export function isMinioService(s: { templateSlug?: string; composeFile?: string }): boolean {
  return s.templateSlug === "minio" || /minio\/minio/.test(s.composeFile ?? "");
}
export const MINIO_SERVICE_NOTE =
  "object data is not copied by this import - use Object migration (keys, sizes, metadata, timestamps; not versions, IAM users, replication or notifications)";

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

/** The per-service note, derived from the verdict. `/not imported/i` appears ONLY for a skipped service. Never claims
 *  anything the import does not do (no "dependents repointed", no "DNS updated", no "tunnel routes rewritten"). */
function serviceNote(a: ReturnType<typeof analyzeService>): string {
  const r = a.result;
  if (a.verdict === "skipped") return `not imported: ${a.skipReason ?? "the service could not be imported"}`;
  if (a.verdict === "partial" && r) {
    const parts: string[] = [];
    if (r.membersDropped.length) parts.push(`imported without: ${r.membersDropped.map((m) => m.name).join(", ")}`);
    const skipped = r.volumes.filter((v) => v.policy === "skip").map((v) => v.key);
    if (skipped.length) parts.push(`the data of ${skipped.join(", ")} is not carried`);
    return `${parts.join("; ")}; created as a stopped compose app, volume data is copied separately and you deploy it yourself`;
  }
  return "imported as a stopped compose app; volume data is copied separately and you deploy it yourself";
}

/** Source-only cutover facts: how many hosts, which are Coolify-generated (excluded by default) and which have a
 *  served www/bare sibling (the importer sets no redirect; Cutover offers to fix it). Pure and secret-free. */
export function buildCutoverHint(fleet: ForeignFleet): ImportCutoverHint {
  const hosts = new Set<string>();
  const generated = new Set<string>();
  const counterpart = new Set<string>();
  for (const app of fleet.apps) {
    const hs = (app.domains ?? []).map((d) => d.host.trim().toLowerCase()).filter(Boolean);
    for (const h of hs) {
      hosts.add(h);
      if (isGeneratedHost(h)) generated.add(h);
      const c = counterpartOf(h);
      if (c && hs.includes(c)) counterpart.add(h);
    }
  }
  return { hosts: hosts.size, generatedHosts: [...generated].sort(), counterpartHosts: [...counterpart].sort() };
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

  const services = fleet.services.map((s) => {
    const a = analyzeService(s);
    const r = a.result;
    return {
      name: s.name,
      members: s.memberApps.length + s.memberDbs.length,
      note: isMinioService(s) ? MINIO_SERVICE_NOTE : serviceNote(a),
      // Only a MinIO service carries the flag (the key is ABSENT otherwise).
      ...(isMinioService(s) ? { objectStore: true as const } : {}),
      verdict: a.verdict,
      ...(r?.hold ? { hold: true } : {}),
      ...(r?.volumes.length ? { volumes: r.volumes.map((v) => ({ key: v.key, dataPlane: v.dataPlane })) } : {}),
    };
  });

  const appsWithVolumeData = carried ? 0 : fleet.apps.filter((a) => (a.volumes ?? []).length > 0).length;
  // Does ANY app actually get an empty volume declared? (A compose-only / all-skipped fleet declares none, so the
  // note must not claim "declared" in that case.)
  const appsDeclaringVolumes = carried ? 0 : fleet.apps.filter((a) => foreignAppToVolumes(a).volumes.length > 0).length;

  const cap = maxVolumeBytes();
  const capMiB = Math.round(cap / (1024 * 1024));
  const volumes = carried ? [] : buildVolumeRows(fleet.apps, inventory, cap, capMiB);

  const envApps = fleet.apps.filter((a) => a.envReport);
  const gitHosts = new Map<string, number>();
  for (const a of fleet.apps) {
    const h = a.git?.url ? gitUrlHost(a.git.url) : null;
    if (h) gitHosts.set(h, (gitHosts.get(h) ?? 0) + 1);
  }
  const git = [...gitHosts.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([host, apps]) => ({ host, apps }));

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
    // Additive, outside planHash. `env` only when the source reports it (Coolify); `git.hosts` so a gitlab/bitbucket
    // host is visible at plan time (those repos are not linked: "unsupported_host").
    ...(envApps.length ? { env: { tokenReadOnlyApps: envApps.filter((a) => a.envReport!.tokenReadOnly).length } } : {}),
    ...(git.length ? { git: { hosts: git } } : {}),
    ...(carried ? {} : { cutover: buildCutoverHint(fleet) }),
  };
}

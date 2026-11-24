import { MIGRATOR_ENGINES } from "./migrator-recipe";
import { UNSUPPORTED_DB_IMPORT, analyzeService, ns } from "./import-planner";
import { foreignAppToVolumes } from "./apply-map";
import { isMinioService } from "./import-service-map";
import { gitUrlHost } from "../deploy/deploy-script";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "./migration-staging";
import { maxVolumeBytes } from "./migration-volume";
import { vxEnabled, vxPartRawBytes } from "./volume-stream/vx-constants";
import type { DbDataPlane, ForeignApp, ForeignDb, ForeignFleet, ImportCutoverHint, ImportOptions, ImportPreflight, PreflightHost, PreflightProject, VolumeDataPlane } from "./foreign-fleet";
import { isDegradedHealth } from "./import-source";
import { counterpartOf, isGeneratedHost } from "../cutover/cutover.logic";

const VX_DB_VOLUME_REASON =
  "Volume copy: the PostgreSQL data directory is copied physically with the source stopped. It is only offered when the same image and major run on both sides, the credentials were carried, the data sits at the volume root and the destination was never started. The migrator's --dry-run reads the source and every check is shown with its evidence before any data moves.";

function volumeCopyNote(engine: string): string {
  if (engine === "POSTGRES") return "A PostgreSQL data volume can instead be copied physically (same image, same major, carried credentials): choose Volume copy for this database and run the migrator with --dry-run to see each check.";
  if (engine === "MYSQL" || engine === "MARIADB") return "Volume copy is not offered for this engine: its root password lives in the copied system tables, so the data is copied logically.";
  return "Volume copy is not offered for this engine: its data is copied logically.";
}

/** The scheduled-backup sentence of a database row: never carried, so the operator recreates it (names the S3 target when known). */
function backupNote(b: ForeignDb["backupSchedule"]): string {
  if (!b) return "";
  const where = b.s3 ? ` and uploads to the S3 target ${b.targets?.length ? b.targets.join(", ") : "(name not readable)"}` : "";
  return ` The source has a scheduled backup${b.interval ? ` (${b.interval})` : ""}${where}: it is not carried - recreate it in Tugra's Backups after the import${b.s3 ? " (add the S3 destination there first)" : ""}.`;
}

const DEFAULT_CAP_MIB = Math.round(DEFAULT_MAX_ARTIFACT_BYTES / (1024 * 1024));

// Mirrors apply-map's canonMountPath so a type lookup matches the mapper's declared path exactly.
const canonMount = (raw?: string): string => (raw ?? "").trim().replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");

export { isMinioService };
export const MINIO_SERVICE_NOTE =
  "object data is not copied by this import - use Object migration (keys, sizes, metadata, timestamps; not versions, IAM users, replication or notifications)";

type VolumeRow = NonNullable<ImportPreflight["volumes"]>[number];

const GiB = 1024 ** 3;

/** What the streamed copy keeps and what it does not (shown on EVERY stream row; the same for every volume). */
export const VX_FIDELITY =
  "Copied: files, directories, symlinks, hard links, numeric owner and group, mode, modification time. Not copied: extended attributes, ACLs, file capabilities, sockets (listed per volume), device nodes (the copy is refused).";
const VX_BIND_NOTE =
  "Bind mounts are refused unless you run the migrator with --allow-bind. Ownership and mode come from the archive headers; extended attributes, ACLs and file capabilities are not copied.";

/**
 * The honest per-volume text of the streamed copy. `rawBytes` is the measured tar size (undefined = not measured yet),
 * `targetFreeBytes` the free space the target reported (undefined = not probed yet). Required space is the stricter,
 * same-filesystem figure the disk verdict uses: the compressed parts (~1x) plus the decoded copy (~1.05x) plus headroom.
 */
export function vxVolumeReason(rawBytes: number | undefined, targetFreeBytes?: number): string {
  if (rawBytes === undefined) {
    return `Streamed by the migrator in resumable parts of about ${Math.round(vxPartRawBytes() / (1024 * 1024))} MiB. The source container must be stopped first. Size is not measured yet: run the migrator with --dry-run to measure it and check free space on the target. The target needs roughly the compressed size while it copies and about the full data size again while it extracts.`;
  }
  const x = Math.max(0.1, Math.round((rawBytes / GiB) * 10) / 10);
  const parts = Math.max(1, Math.ceil(rawBytes / vxPartRawBytes()));
  const y = Math.ceil((2.05 * rawBytes + GiB) / GiB);
  const free = targetFreeBytes === undefined ? "run the migrator with --dry-run to see how much the target has" : `has ${Math.floor(targetFreeBytes / GiB)} GiB`;
  return `About ${x} GiB in about ${parts} parts. The source must stay stopped for the whole copy (downtime until you start the app on the target). The target needs about ${y} GiB free and ${free}.`;
}

/**
 * Per-app-volume data-movement rows. Declared-eligible mounts are `hub-staged` (or `manual-large` when a
 * supplied inventory measures them over the live cap); skipped mounts carry their skip reason as `manual`.
 * `inventory` maps `"<appName>:<containerPath>"` → compressed bytes; it is omitted at plan time (the Go
 * `--inventory` producer is deferred), so an eligible mount is size-unmeasured, never assumed small.
 */
function buildVolumeRows(apps: ForeignApp[], inventory: ReadonlyMap<string, number> | undefined, cap: number, capMiB: number, vx: boolean): VolumeRow[] {
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
      if (vx) {
        // Streamed copy: declared volumes of any size move through the hub's memory relay (no hub disk, no cap).
        dataPlane = "stream";
        reason = vxVolumeReason(size) + (isBind ? ` ${VX_BIND_NOTE}` : "");
        rows.push({ app: app.name, mountPath: v.path, type, dataPlane, reason, fidelity: VX_FIDELITY });
        continue;
      }
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
  // R13: the services' own routes (the importer carries them as compose service domains) flip at cutover too. Only the rows the
  // import would actually create count: a service it skips, or a member it drops, brings no route to flip.
  const serviceHosts = new Set<string>();
  for (const svc of fleet.services) {
    for (const row of analyzeService(svc).result?.domains ?? []) {
      const h = row.hostname.trim().toLowerCase();
      if (!h) continue;
      serviceHosts.add(h);
      hosts.add(h);
      if (isGeneratedHost(h)) generated.add(h);
    }
  }
  return { hosts: hosts.size, generatedHosts: [...generated].sort(), counterpartHosts: [...counterpart].sort(), ...(serviceHosts.size ? { serviceHosts: [...serviceHosts].sort() } : {}) };
}

/**
 * Build the advisory preflight for a discovered fleet: per-DB data-movement class, the services the plan does
 * NOT import (so they are never a silent drop), and the volume-data caveat. Pure and secret-free.
 */
export function buildPreflight(fleet: ForeignFleet, options: ImportOptions, inventory?: ReadonlyMap<string, number>): ImportPreflight {
  const carried = options.sourceKind === "local-docker"; // adopts in place; volumes re-attach, data not copied
  const vx = vxEnabled(); // streamed volume copy: the declared volumes' data moves through the migrator, uncapped

  const databases = fleet.databases.map((d) => {
    const c = classifyDbDataPlane(d.engine);
    const ref = `database:${d.serverRef ?? "_"}:${d.sourceRef}`;
    if (c.dataPlane === "one-click" && options.dbDataModes?.[ref] === "volume") {
      if (d.engine === "POSTGRES") {
        return { name: d.name, engine: d.engine, dataPlane: "volume" as DbDataPlane, reason: VX_DB_VOLUME_REASON };
      }
      return { name: d.name, engine: d.engine, dataPlane: "blocked" as DbDataPlane, reason: `volume copy is only offered for PostgreSQL, not ${d.engine}; the plan blocks this choice (use the logical dump)` };
    }
    // Volume copy is a Postgres-only choice; say WHY for the others instead of staying silent.
    const volumeNote = vx && c.dataPlane === "one-click" ? ` ${volumeCopyNote(d.engine)}` : "";
    return { name: d.name, engine: d.engine, dataPlane: c.dataPlane, reason: c.reason + volumeNote + backupNote(d.backupSchedule), ...(d.backupSchedule ? { backup: d.backupSchedule } : {}) };
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
      ...(r?.volumes.length ? { volumes: r.volumes.map((v) => ({ key: v.key, dataPlane: v.dataPlane, ...(v.origin === "host-bind" ? { origin: "host-bind" as const } : {}) })) } : {}),
    };
  });

  const appsWithVolumeData = carried ? 0 : fleet.apps.filter((a) => (a.volumes ?? []).length > 0).length;
  // Does ANY app actually get an empty volume declared? (A compose-only / all-skipped fleet declares none, so the
  // note must not claim "declared" in that case.)
  const appsDeclaringVolumes = carried ? 0 : fleet.apps.filter((a) => foreignAppToVolumes(a).volumes.length > 0).length;

  const cap = maxVolumeBytes();
  const capMiB = Math.round(cap / (1024 * 1024));
  const volumes = carried ? [] : buildVolumeRows(fleet.apps, inventory, cap, capMiB, vx);

  const envApps = fleet.apps.filter((a) => a.envReport);
  const gitHosts = new Map<string, number>();
  for (const a of fleet.apps) {
    const h = a.git?.url ? gitUrlHost(a.git.url) : null;
    if (h) gitHosts.set(h, (gitHosts.get(h) ?? 0) + 1);
  }
  const git = [...gitHosts.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([host, apps]) => ({ host, apps }));

  // the source servers by name, with the facts a run's PREFLIGHT classifies them by (no address leaves the hub through the plan)
  const hosts: PreflightHost[] = fleet.servers.map((s) => ({
    ref: s.ref,
    ...(s.name ? { name: s.name } : {}),
    ...(s.controlPlane ? { controlPlane: true as const } : {}),
    ...(s.unreachableCount !== undefined ? { unreachableCount: s.unreachableCount } : {}),
    ...(s.os ? { os: s.os } : {}),
  }));

  const projects = carried ? [] : sourceProjectsOf(fleet);

  // apps that were already failing at the source (a dead or crash-looping app is otherwise invisible in the plan)
  const sourceHealth = carried
    ? []
    : fleet.apps
        .filter((a) => a.sourceHealth && isDegradedHealth(a.sourceHealth.health, a.sourceHealth.restartCount))
        .map((a) => ({ itemRef: ns("app", a.serverRef, a.sourceRef), name: a.name, health: a.sourceHealth!.health as "unhealthy" | "unknown" | "exited", ...(a.sourceHealth!.status ? { status: a.sourceHealth!.status } : {}), restartCount: a.sourceHealth!.restartCount }))
        .sort((x, y) => (x.itemRef < y.itemRef ? -1 : x.itemRef > y.itemRef ? 1 : 0));

  return {
    databases,
    services,
    appsWithVolumeData,
    volumeDataNote:
      appsWithVolumeData === 0
        ? undefined
        : appsDeclaringVolumes > 0 && vx
          ? "empty volumes are declared on the new apps; the migrator streams their DATA in resumable parts with owner, group and mode kept (stop each source container first, a live copy is refused). Run the migrator with --dry-run to measure every volume and check the target's free space before choosing a window. A volume you do not want copied must be excluded explicitly: it is then reported as not migrated, never skipped silently. Small volumes can still be uploaded by hand to the hub before the first deploy"
          : appsDeclaringVolumes > 0
          ? `empty volumes are declared on the new apps; upload their DATA to the hub before the first deploy (tar each source volume and curl it to the migration endpoint, up to ~${capMiB} MiB per volume; file ownership is not preserved, and a live tar is not crash-consistent — stop the source app first). Larger volumes are copied manually, or the app starts empty`
          : `these volumes are compose-managed or skipped (not declared on the target) — recreate and copy their DATA manually before the first deploy or the app starts empty`,
    ...(volumes.length ? { volumes } : {}),
    // Additive, outside planHash. `env` only when the source reports it (Coolify); `git.hosts` so a gitlab/bitbucket
    // host is visible at plan time (those repos are not linked: "unsupported_host").
    ...(envApps.length ? { env: { tokenReadOnlyApps: envApps.filter((a) => a.envReport!.tokenReadOnly).length } } : {}),
    ...(git.length ? { git: { hosts: git } } : {}),
    ...(carried ? {} : { cutover: buildCutoverHint(fleet) }),
    // the source servers by name with their classification facts; a local-docker source has only its own anonymous server
    ...(hosts.length > 0 && !carried ? { hosts } : {}),
    ...(projects.length ? { projects } : {}),
    ...(sourceHealth.length ? { sourceHealth } : {}),
  };
}

/** The source projects that hold at least one app, database or service, each with the itemRefs in it (sorted by name, then ref). */
export function sourceProjectsOf(fleet: Pick<ForeignFleet, "projects" | "apps" | "databases" | "services">): PreflightProject[] {
  const byRef = new Map<string, string[]>();
  const put = (kind: string, r: { serverRef?: string; sourceRef: string; projectRef?: string }) => {
    if (!r.projectRef) return;
    byRef.set(r.projectRef, [...(byRef.get(r.projectRef) ?? []), ns(kind, r.serverRef, r.sourceRef)]);
  };
  for (const a of fleet.apps) put("app", a);
  for (const d of fleet.databases) put("database", d);
  for (const s of fleet.services ?? []) put("service", s);
  const out: PreflightProject[] = [];
  for (const p of fleet.projects ?? []) {
    const itemRefs = byRef.get(p.ref);
    if (itemRefs?.length) out.push({ ref: p.ref, name: p.name, itemRefs: [...itemRefs].sort() });
  }
  return out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.ref < b.ref ? -1 : 1));
}

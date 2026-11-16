import { DUMP_VOLUME_NAME, VOLUME_ITEMREF_RE, isStreamDumpEngine } from "./vx-constants";
import { DB_ITEMREF_RE } from "./vx.dto";
import { composeProject } from "../../deploy/compose-script";

/** Source container names/uuids the hub is willing to put into a volume itemRef (mirrors the Go sourceRefRe). */
const SOURCE_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const SERVER_REF_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface VxTaskLite {
  itemRef: string | null;
  kind: string;
  status: string;
  resourceType: string | null;
  resourceId: string | null;
  result: unknown;
}
export interface VxDbLite {
  id: string;
  engine: string;
  version: string;
  image: string;
}
export interface VxExclusion {
  reason: string;
  at: string;
  by: string;
}

/** One data-bearing volume the migrator may stream for an op (secret-free; no host paths). */
export interface VxVolumeTarget {
  itemRef: string; // volume:<serverRef|_>:<sourceRef>:<volName>
  /** `db-dump` = a database moved by the STREAMED DUMP lane (no volume is involved: the dump is restored through the engine's own client). */
  destType: "app-volume" | "db-data" | "db-dump";
  name: string; // dest.name (the declared volume name, "data", or "dump")
  mountPath: string;
  /** The owning application task's itemRef (`app:`), or the compose SERVICE's (`service:`) when {@link ownerKind} is `service`. */
  appItemRef?: string;
  /** `service`: the volume belongs to an imported compose service (a stopped compose app); it reuses the app-volume lane end to end. */
  ownerKind?: "service";
  databaseItemRef?: string;
  engine?: string;
  engineVersion?: string;
  sourceImage?: string;
  /** Set when the owner explicitly excluded this volume (reported `volume-not-migrated`, never silently skipped). */
  excluded?: VxExclusion;
}

/** One data volume of an imported compose service, as the importer recorded it in the service task's result. */
export interface ServiceVolumeRow {
  key: string;
  policy: string;
  /** Where the SOURCE container mounts the volume (the first mount of the first kept member that has one); null when the result has none. */
  mountPath: string | null;
}

/** A container path the stream may carry in a target row: absolute, plain, no traversal and no control characters. */
const SERVICE_MOUNT_RE = /^\/[A-Za-z0-9._@+=,\/-]{0,299}$/;
export function validServiceMountPath(p: unknown): p is string {
  return typeof p === "string" && SERVICE_MOUNT_RE.test(p) && !p.split("/").includes("..");
}

/**
 * The volumes the importer recorded in a compose SERVICE task's result (`result.volumes`: key, policy and, since the service lane,
 * the mounts). Pure and tolerant: anything that is not an object with a string key is dropped.
 */
export function serviceVolumesOf(result: unknown): ServiceVolumeRow[] {
  const v = result && typeof result === "object" ? (result as { volumes?: unknown }).volumes : undefined;
  if (!Array.isArray(v)) return [];
  const out: ServiceVolumeRow[] = [];
  for (const x of v as Array<{ key?: unknown; policy?: unknown; mounts?: unknown }>) {
    if (!x || typeof x !== "object" || typeof x.key !== "string") continue;
    const mounts = Array.isArray(x.mounts) ? (x.mounts as Array<{ path?: unknown }>) : [];
    const first = mounts.find((m) => m && validServiceMountPath(m.path));
    out.push({ key: x.key, policy: typeof x.policy === "string" ? x.policy : "copy", mountPath: first ? (first.path as string) : null });
  }
  return out;
}

/**
 * Can this service volume ride the streamed lane? It carries data (`policy: copy`), its key is a valid stream volume name and the
 * importer recorded where the source mounts it. A copy volume that fails this is reported by VERIFY as not migrated, never skipped silently.
 */
export function serviceVolumeStreamable(v: ServiceVolumeRow): boolean {
  return v.policy === "copy" && v.mountPath !== null && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v.key);
}

/** The docker volume a compose service's key becomes on the target: the compose project (`tugra_<appId>`) plus the key, exactly what the service's compose file declares. */
export function serviceVolumeName(app: { id: string }, key: string): string {
  return `${composeProject(app)}_${key}`;
}

export const DB_DATA_NAME = "data";
export const PG_DATA_MOUNT = "/var/lib/postgresql/data";

export function volumeItemRef(ownerItemRef: string, volName: string): string | null {
  // ownerItemRef is `<kind>:<serverRef|_>:<sourceRef>` (planner ns()).
  const parts = ownerItemRef.split(":");
  if (parts.length !== 3) return null;
  const [, serverRef, sourceRef] = parts;
  if (!SERVER_REF_RE.test(serverRef) || !SOURCE_REF_RE.test(sourceRef)) return null;
  const ref = `volume:${serverRef}:${sourceRef}:${volName}`;
  return VOLUME_ITEMREF_RE.test(ref) ? ref : null;
}

/** The itemRef split back into its owner (`app:`/`database:` ref) and volume name; null when malformed. */
export function parseVolumeItemRef(itemRef: string): { serverRef: string; sourceRef: string; volName: string; appItemRef: string; databaseItemRef: string } | null {
  const m = VOLUME_ITEMREF_RE.exec(itemRef);
  if (!m) return null;
  return { serverRef: m[1], sourceRef: m[2], volName: m[3], appItemRef: `app:${m[1]}:${m[2]}`, databaseItemRef: `database:${m[1]}:${m[2]}` };
}

/** Plan items the op was created from whose DB data mode is `volume` (key present ONLY then). */
export function dbVolumeModeRefs(planItems: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(planItems)) return out;
  for (const it of planItems as Array<{ itemRef?: unknown; kind?: unknown; proposed?: { dataMode?: unknown } }>) {
    if (it?.kind === "database" && typeof it.itemRef === "string" && it.proposed?.dataMode === "volume") out.add(it.itemRef);
  }
  return out;
}

/**
 * The databases of an op whose data moves by the streamed dump lane: the keys of `BulkOperation.meta.vxStream`, written by the
 * run's DATA_SEED when the measured dump size, the engine and the owner's policy say so. Only well-formed database itemRefs count.
 */
export function dbStreamModeRefs(meta: unknown): Set<string> {
  const out = new Set<string>();
  const v = (meta && typeof meta === "object" ? (meta as { vxStream?: unknown }).vxStream : undefined) as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const k of Object.keys(v)) if (DB_ITEMREF_RE.test(k)) out.add(k);
  return out;
}

/**
 * Every volume the migrator can stream for an op: each DECLARED volume of a DONE app task (runCopyApp recorded the
 * mounts), each copy volume of a DONE compose SERVICE task (runCopyService recorded the mounts), plus a Postgres database whose plan item chose `dataMode:"volume"`. Deterministic order (by itemRef).
 * Pure: the caller supplies the tasks, the DB rows, the plan's volume-mode refs and the explicit exclusions.
 */
export function buildVolumeTargets(opts: {
  tasks: VxTaskLite[];
  dbs: ReadonlyMap<string, VxDbLite>; // resourceId -> db
  dbVolumeRefs: ReadonlySet<string>;
  /** Databases moved by the streamed dump lane: they get a `db-dump` target and NEVER a `db-data` one (the dump lane wins over a physical plan item). */
  dbStreamRefs?: ReadonlySet<string>;
  excluded?: Readonly<Record<string, VxExclusion>>;
}): VxVolumeTarget[] {
  const out: VxVolumeTarget[] = [];
  for (const t of opts.tasks) {
    if (t.status !== "DONE" || !t.resourceId || !t.itemRef) continue;
    if (t.resourceType === "application" && t.kind === "app") {
      const res = t.result && typeof t.result === "object" ? (t.result as { volumes?: { mounts?: Array<{ path: string; name: string }>; declared?: number; error?: string } }).volumes : undefined;
      const declaredOk = !!res && !res.error && (res.declared ?? 0) > 0 && Array.isArray(res.mounts);
      if (!declaredOk) continue;
      for (const m of res!.mounts!) {
        const ref = volumeItemRef(t.itemRef, m.name);
        if (!ref || typeof m.path !== "string") continue;
        out.push({ itemRef: ref, destType: "app-volume", name: m.name, mountPath: m.path, appItemRef: t.itemRef });
      }
    } else if (t.resourceType === "application" && t.kind === "service") {
      // a compose SERVICE (search engine, document converter, ...): each copy volume is an app-volume target owned by the service's app
      for (const v of serviceVolumesOf(t.result)) {
        if (!serviceVolumeStreamable(v)) continue;
        const ref = volumeItemRef(t.itemRef, v.key);
        if (!ref) continue;
        out.push({ itemRef: ref, destType: "app-volume", name: v.key, mountPath: v.mountPath as string, appItemRef: t.itemRef, ownerKind: "service" });
      }
    } else if (t.resourceType === "database" && t.kind === "database" && opts.dbStreamRefs?.has(t.itemRef)) {
      const db = opts.dbs.get(t.resourceId);
      if (!db || !isStreamDumpEngine(db.engine)) continue;
      const ref = volumeItemRef(t.itemRef, DUMP_VOLUME_NAME);
      if (!ref) continue;
      out.push({ itemRef: ref, destType: "db-dump", name: DUMP_VOLUME_NAME, mountPath: "", databaseItemRef: t.itemRef, engine: db.engine, engineVersion: db.version, sourceImage: db.image });
    } else if (t.resourceType === "database" && t.kind === "database" && opts.dbVolumeRefs.has(t.itemRef)) {
      const db = opts.dbs.get(t.resourceId);
      if (!db || db.engine !== "POSTGRES") continue;
      const ref = volumeItemRef(t.itemRef, DB_DATA_NAME);
      if (!ref) continue;
      out.push({ itemRef: ref, destType: "db-data", name: DB_DATA_NAME, mountPath: PG_DATA_MOUNT, databaseItemRef: t.itemRef, engine: "POSTGRES", engineVersion: db.version, sourceImage: db.image });
    }
  }
  for (const v of out) {
    const ex = opts.excluded?.[v.itemRef];
    if (ex) v.excluded = ex;
  }
  return out.sort((a, b) => (a.itemRef < b.itemRef ? -1 : a.itemRef > b.itemRef ? 1 : 0));
}

/** The major of a Postgres version string ("16", "16.4", "17-alpine" -> "16" / "16" / "17"); null when unparseable. */
export function pgMajorOf(version: string | null | undefined): string | null {
  const m = /^(\d{1,2})(?:[.-]|$)/.exec((version ?? "").trim());
  return m ? m[1] : null;
}

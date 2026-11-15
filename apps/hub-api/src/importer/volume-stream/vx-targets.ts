import { VOLUME_ITEMREF_RE } from "./vx-constants";

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
  destType: "app-volume" | "db-data";
  name: string; // dest.name (the declared volume name, or "data")
  mountPath: string;
  appItemRef?: string;
  databaseItemRef?: string;
  engine?: string;
  engineVersion?: string;
  sourceImage?: string;
  /** Set when the owner explicitly excluded this volume (reported `volume-not-migrated`, never silently skipped). */
  excluded?: VxExclusion;
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
 * Every volume the migrator can stream for an op: each DECLARED volume of a DONE app task (runCopyApp recorded the
 * mounts), plus a Postgres database whose plan item chose `dataMode:"volume"`. Deterministic order (by itemRef).
 * Pure: the caller supplies the tasks, the DB rows, the plan's volume-mode refs and the explicit exclusions.
 */
export function buildVolumeTargets(opts: {
  tasks: VxTaskLite[];
  dbs: ReadonlyMap<string, VxDbLite>; // resourceId -> db
  dbVolumeRefs: ReadonlySet<string>;
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

/**
 * The in-place takeover of a Coolify compose service as pure logic (Coolify hub takeover, lane F, services): a one-click service or a
 * docker-compose app has several containers, each of which becomes a Tugra-managed container of the compose app the import created, on the
 * same image, on the same data, with the same network names. No database, no agent, no clock. Names, ids, counts and codes only: no
 * environment value, no label value beyond the compose service name, no key ever enters this file.
 */
import { parse } from "yaml";
import type { TakeoverDbVerifyLevel, TakeoverIssueCode, TakeoverMemberView } from "@tugra/shared";
import { isUserNetworkNameAllowed } from "../deploy/network-names";
import type { ComposeNetworkRow } from "../deploy/deploy-script";
import { checkLevelOf, isFingerprintEngine, sameDatabase, type CtrMount, type DbFingerprint, type FingerprintEngine, type InPlaceRestartPolicy } from "./inplace-scripts";

// ───────────────────────────── the Tugra compose, as far as the takeover needs it ─────────────────────────────

export interface ComposeServiceFacts {
  /** The image the compose app runs the service on; null when it builds one (nothing to reuse). */
  image: string | null;
  /** Services this one waits for (`depends_on`, list or map form). */
  dependsOn: string[];
  /** Named volumes mounted: the compose volume key and where. */
  named: Array<{ source: string; target: string }>;
  /** Absolute host paths bound: where from and where to. */
  binds: Array<{ source: string; target: string }>;
  /** A mount with no source: docker gives it a fresh anonymous volume, which can never be the data Coolify's container holds. */
  anonymous: string[];
}

/** The compose app's own view of its volumes (`composeVolumes` in the deploy code): the key and the docker volume it stands for. */
export interface ComposeVolumeFacts {
  key: string;
  dockerName: string;
  external: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `src:dst[:mode]` or the long form, into named / bind / anonymous. A relative bind (a config file the import carried as a mount) is none of them. */
function volumeEntry(e: unknown): { kind: "named" | "bind" | "anonymous"; source: string; target: string } | null {
  let src: string | undefined;
  let dst: string | undefined;
  let type: string | undefined;
  if (typeof e === "string") {
    const parts = e.split(":");
    if (parts.length === 1) return parts[0].startsWith("/") ? { kind: "anonymous", source: "", target: parts[0] } : null;
    src = parts[0];
    dst = parts[1];
  } else if (isObj(e)) {
    type = typeof e.type === "string" ? e.type : undefined;
    src = typeof e.source === "string" ? e.source : undefined;
    dst = typeof e.target === "string" ? e.target : undefined;
    if (dst && !src && (!type || type === "volume")) return { kind: "anonymous", source: "", target: dst };
  }
  if (!src || !dst || !dst.startsWith("/")) return null;
  if (type === "tmpfs") return null;
  if (type === "bind" || src.startsWith("/")) return src.startsWith("/") ? { kind: "bind", source: src, target: dst } : null;
  if (src.startsWith(".") || src.startsWith("~")) return null; // relative bind: a config file, not data
  return { kind: "named", source: src, target: dst };
}

/** Parse the stored compose of the Tugra app. `null` when it is not a mapping with services (nothing can be taken over from it). */
export function parseServiceCompose(composeFile: string | null | undefined): Record<string, ComposeServiceFacts> | null {
  if (!composeFile) return null;
  let doc: unknown;
  try {
    doc = parse(composeFile, { merge: true });
  } catch {
    return null;
  }
  if (!isObj(doc) || !isObj(doc.services)) return null;
  const out: Record<string, ComposeServiceFacts> = {};
  for (const [name, def] of Object.entries(doc.services)) {
    if (!isObj(def)) return null;
    const dep = def.depends_on;
    const dependsOn = Array.isArray(dep) ? dep.filter((x): x is string => typeof x === "string") : isObj(dep) ? Object.keys(dep) : [];
    const f: ComposeServiceFacts = { image: typeof def.image === "string" && def.image.trim() ? def.image.trim() : null, dependsOn, named: [], binds: [], anonymous: [] };
    for (const e of Array.isArray(def.volumes) ? def.volumes : []) {
      const v = volumeEntry(e);
      if (!v) continue;
      if (v.kind === "named") f.named.push({ source: v.source, target: v.target });
      else if (v.kind === "bind") f.binds.push({ source: v.source, target: v.target });
      else f.anonymous.push(v.target);
    }
    out[name] = f;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Services in start order: a service after everything it depends on, ties by name so the order is the same every time. A name that is not a
 * service of the file is ignored; a cycle (compose refuses it anyway) falls back to name order for what is left.
 */
export function startOrder(compose: Record<string, ComposeServiceFacts>): string[] {
  const names = Object.keys(compose).sort();
  const done = new Set<string>();
  const out: string[] = [];
  while (out.length < names.length) {
    const next = names.find((n) => !done.has(n) && compose[n].dependsOn.every((d) => done.has(d) || !(d in compose) || d === n));
    const pick = next ?? names.find((n) => !done.has(n)) ?? "";
    if (!pick) break;
    done.add(pick);
    out.push(pick);
  }
  return out;
}

// ───────────────────────────── what Coolify runs for the service ─────────────────────────────

export interface CtrNetwork {
  name: string;
  aliases: string[];
}

/** What the host showed for one container of the Coolify service (no environment, no label but the compose service name). */
export interface ServiceCtrFacts {
  id: string;
  name: string;
  image: string;
  imageId: string;
  /** The registry digests and the version label of the image it runs, when the host reported them. */
  repoDigests?: string[];
  imageVersion?: string;
  restart: InPlaceRestartPolicy;
  /** The compose service name Coolify's container carries, or null when it carries none. */
  service: string | null;
  mounts: CtrMount[];
  networks: CtrNetwork[];
  /** How many ports the container publishes on the host. */
  published: number;
}

export interface VolumeAlias {
  from: string;
  to: string;
  key: string;
}

export interface ServiceMemberRecord {
  /** The compose service name (the Tugra compose app's key). */
  service: string;
  container: { id: string; name: string; image: string; restart: InPlaceRestartPolicy; imageId: string; repoDigests?: string[]; imageVersion?: string };
  /** The image the Tugra compose app runs this service on (its reference, as written there). */
  composeImage: string;
  /** Volume aliases: Coolify's named volume becomes the Tugra compose app's volume (`key` is its compose volume key). */
  volumes: VolumeAlias[];
  /** Host-path aliases: a folder Coolify's container binds becomes the Tugra compose app's volume (a bind volume on the same folder). */
  binds: VolumeAlias[];
  /** The engine when the image is a database, checked before and after the switch. */
  engine?: FingerprintEngine;
  dbBefore?: DbFingerprint | null;
  dbVerify?: { level: TakeoverDbVerifyLevel; state: "pending" | "ok" | "failed" };
  ready: "pending" | "ok" | "failed";
}

/** The database engine an image is, when it is a database whose data can be checked; undefined otherwise (`image` may carry a registry, a tag and a digest). */
export function engineOfImage(image: string): FingerprintEngine | undefined {
  const repo = image.toLowerCase().split("@")[0].replace(/:[^/]*$/, "");
  const base = repo.split("/").pop() ?? "";
  const eng: Record<string, FingerprintEngine> = {
    postgres: "POSTGRES",
    postgis: "POSTGRES",
    pgvector: "POSTGRES",
    timescaledb: "POSTGRES",
    mysql: "MYSQL",
    mariadb: "MARIADB",
    redis: "REDIS",
    keydb: "KEYDB",
    dragonfly: "DRAGONFLY",
    mongo: "MONGO",
  };
  const e = eng[base];
  return e && isFingerprintEngine(e) ? e : undefined;
}

export interface MountMapping {
  volumes: VolumeAlias[];
  binds: VolumeAlias[];
  exclusive: boolean;
  issues: TakeoverIssueCode[];
}

/**
 * How one container's writable data lines up with the Tugra compose app. A Coolify named volume mounted at a path becomes an alias of the
 * compose volume the Tugra service declares for that path; a folder Coolify bound there (the import carries a host-path bind as a named
 * volume) becomes a bind volume on that same folder; a bind the Tugra compose declares itself (same folder, same path) is used as it is. No copy:
 * the same files. A writable mount with no counterpart is an issue and the service stays out: starting it without its data would be worse than
 * not starting it. A read-only mount without a counterpart is a config file the import carried as a Tugra config mount.
 */
export function mapServiceMounts(mounts: readonly CtrMount[], svc: ComposeServiceFacts | undefined, volumes: readonly ComposeVolumeFacts[]): MountMapping {
  const res: MountMapping = { volumes: [], binds: [], exclusive: false, issues: [] };
  const issue = (c: TakeoverIssueCode): void => {
    if (!res.issues.includes(c)) res.issues.push(c);
  };
  for (const m of mounts) {
    if (m.type === "tmpfs" || m.type === "other") continue;
    const named = svc?.named.find((n) => n.target === m.destination);
    const vol = named ? volumes.find((v) => v.key === named.source) : undefined;
    if (m.type === "volume") {
      if (!vol) {
        if (m.rw) issue("volume_unmapped");
        continue;
      }
      res.volumes.push({ from: m.source, to: vol.dockerName, key: vol.key });
      if (m.rw) res.exclusive = true;
      continue;
    }
    // a host folder
    if (vol) {
      res.binds.push({ from: m.source, to: vol.dockerName, key: vol.key });
      if (m.rw) res.exclusive = true;
      continue;
    }
    if (svc?.binds.some((b) => b.source === m.source && b.target === m.destination)) {
      if (m.rw) res.exclusive = true;
      continue;
    }
    if (m.rw) issue("bind_unmapped");
  }
  // the compose declares an anonymous volume where Coolify's container has real data: the new anonymous volume would start empty
  for (const a of svc?.anonymous ?? []) if (mounts.some((m) => m.destination === a && m.rw && m.type === "volume")) issue("volume_unmapped");
  // one Tugra volume cannot stand for two different sources
  const target = new Map<string, string>();
  for (const p of [...res.volumes, ...res.binds]) {
    const prev = target.get(p.to);
    if (prev !== undefined && prev !== p.from) issue("volume_unmapped");
    target.set(p.to, p.from);
  }
  res.volumes = dedupe(res.volumes);
  res.binds = dedupe(res.binds);
  return res;
}

function dedupe(l: VolumeAlias[]): VolumeAlias[] {
  const seen = new Set<string>();
  return l.filter((p) => (seen.has(`${p.from}\u0000${p.to}`) ? false : (seen.add(`${p.from}\u0000${p.to}`), true)));
}

// ───────────────────────────── networks and aliases ─────────────────────────────

/** Networks Coolify's containers sit on that Tugra's own routing replaces (the proxy network) or docker owns. */
const NOT_CARRIED_NETWORKS = new Set(["bridge", "host", "none", "coolify", "coolify-overlay"]);
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SHORT_ID = /^[0-9a-f]{12}$/;
/** The compose app's override can carry this many network attachments (the hub's own limit). */
export const MAX_NETWORK_ROWS = 8;
export const MAX_NETWORK_ALIASES = 4;

/**
 * The network attachments the Tugra compose app needs so the names inside the service still resolve and so do the names other containers on
 * Coolify's per-service network use: every user network a Coolify container is on (the proxy network and docker's own excluded, Tugra's proxy
 * network comes from the routing), under the aliases it had there plus its own container name. Merged into the rows the app already has (the
 * import's private network, say), never replacing one. A name that cannot be carried, or more attachments than the app can hold, is an issue
 * rather than a quiet loss.
 */
export function mapNetworks(
  members: ReadonlyArray<{ service: string; container: { name: string }; networks: readonly CtrNetwork[] }>,
  existing: readonly ComposeNetworkRow[],
  coolifyUuid: string,
): { rows: ComposeNetworkRow[]; issues: TakeoverIssueCode[] } {
  const rows: ComposeNetworkRow[] = existing.map((r) => ({ network: r.network, service: r.service, aliases: [...r.aliases] }));
  const issues: TakeoverIssueCode[] = [];
  for (const m of members) {
    for (const n of m.networks) {
      if (NOT_CARRIED_NETWORKS.has(n.name) || n.name === `${coolifyUuid}_default`) continue;
      if (!isUserNetworkNameAllowed(n.name)) continue; // Tugra's own networks are Tugra's to attach
      if (!DNS_LABEL.test(n.name)) {
        issues.push("service_networks_unmapped");
        continue;
      }
      const wanted = [m.container.name.toLowerCase(), ...n.aliases.map((a) => a.toLowerCase())].filter((a) => !SHORT_ID.test(a) && a !== m.service.toLowerCase());
      const aliases: string[] = [];
      for (const a of wanted) {
        if (aliases.includes(a)) continue;
        if (!DNS_LABEL.test(a)) issues.push("service_networks_unmapped");
        else aliases.push(a);
      }
      let row = rows.find((r) => r.network === n.name && r.service === m.service);
      if (!row) {
        row = { network: n.name, service: m.service, aliases: [] };
        rows.push(row);
      }
      for (const a of aliases) if (!row.aliases.includes(a)) row.aliases.push(a);
      if (row.aliases.length > MAX_NETWORK_ALIASES) issues.push("service_networks_unmapped");
    }
  }
  if (rows.length > MAX_NETWORK_ROWS) issues.push("service_networks_unmapped");
  return { rows, issues: [...new Set(issues)] };
}

/** Do the rows differ from the ones the app has (so the hub has something to change, and to put back)? */
export function sameNetworkRows(a: readonly ComposeNetworkRow[], b: readonly ComposeNetworkRow[]): boolean {
  const key = (r: ComposeNetworkRow): string => `${r.network}\u0000${r.service}\u0000${[...r.aliases].sort().join(",")}`;
  return a.length === b.length && [...a].map(key).sort().join("\n") === [...b].map(key).sort().join("\n");
}

// ───────────────────────────── readiness after the switch ─────────────────────────────

/** One container of Tugra's compose project as the host shows it right now. */
export interface MemberProbe {
  service: string;
  name: string;
  /** docker's state: `running`, `restarting`, `exited`, `created`, `dead`, `paused`. */
  state: string;
  health: "healthy" | "unhealthy" | "starting" | "none";
  restarts: number;
}

export interface ReadyVerdict {
  ready: boolean;
  /** Services not ready yet or not ready at all, in start order. */
  notReady: string[];
  /** Services whose container died or keeps restarting: no reason to wait longer. */
  dead: string[];
}

/**
 * Is every member up? A member is ready when its container runs and is healthy (or has no health check), and it looked the same on the
 * poll before (same restart count): a container that is crash-looping is `running` for an instant between restarts, and one poll cannot tell.
 * `exited` and `dead` end the wait at once. The verdict lists services in start order so the first one named is the first to fix.
 */
export function judgeReady(prev: readonly MemberProbe[] | null, cur: readonly MemberProbe[], order: readonly string[]): ReadyVerdict {
  const notReady: string[] = [];
  const dead: string[] = [];
  for (const s of order) {
    const now = cur.filter((p) => p.service === s);
    if (now.length === 0) {
      notReady.push(s);
      continue;
    }
    let ok = true;
    for (const p of now) {
      if (p.state === "exited" || p.state === "dead") {
        dead.push(s);
        ok = false;
        continue;
      }
      const before = prev?.find((x) => x.name === p.name);
      const stable = !!before && before.state === "running" && before.restarts === p.restarts;
      if (!(p.state === "running" && (p.health === "healthy" || p.health === "none") && stable)) ok = false;
    }
    if (!ok) notReady.push(s);
  }
  return { ready: notReady.length === 0, notReady: [...new Set(notReady)], dead: [...new Set(dead)] };
}

// ───────────────────────────── database-like members ─────────────────────────────

/** Members as the screen is shown them. */
export function memberViews(members: readonly ServiceMemberRecord[]): TakeoverMemberView[] {
  return members.map((m) => ({ name: m.service, ready: m.ready, ...(m.dbVerify ? { verify: m.dbVerify } : {}) }));
}

/** The level a database-like member is checked at, from its engine. */
export const memberLevel = (m: Pick<ServiceMemberRecord, "engine">): TakeoverDbVerifyLevel => (m.engine ? checkLevelOf(m.engine) : "alive");

/** After the switch: did the database-like member look the same through Tugra's container as Coolify's did before? */
export const memberSame = (m: Pick<ServiceMemberRecord, "dbBefore">, after: DbFingerprint | null | undefined): boolean => sameDatabase(m.dbBefore, after);

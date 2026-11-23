/**
 * PREFLIGHT host and target classification (R5, R7): pure rules over facts the hub already holds, so the gate can say
 * before anything is created which hosts need attention.
 *
 *  - SOURCE hosts (from the plan): the control-plane box, hosts whose reachability flaps, hosts on a very new OS release and
 *    hosts that carry nothing of this run.
 *  - TARGET servers (from the Tugra database): free disk and OS release.
 *
 * Nothing here reads a clock, a file or the network. A fact that is not known is `undefined`/`null` and every rule reads that
 * as "not known", never as healthy.
 */
import type { PreflightHost } from "../../../../importer/foreign-fleet";

const GIB = 1024 ** 3;

/** The least free space a target must report before a run lands on it (the streamed copy alone needs about 2x the data). */
export const TARGET_MIN_FREE_BYTES = 10 * GIB;
/** And the least share of the disk that must be free: a nearly full disk fails whatever its size. */
export const TARGET_MIN_FREE_FRACTION = 0.05;
/** A target's disk reading older than this is not a reading of the disk as it is now. */
export const DISK_READING_MAX_AGE_SEC = 3600;
/** A source host whose reachability check failed this many times in a row is flaky enough to mention before a run commits to it. */
export const FLAKY_UNREACHABLE_COUNT = 5;

/**
 * The newest OS release per distribution the agent and the migrator are known to run on. A host above it is flagged (never
 * blocked): nobody has tried it. A distribution that is not listed is not judged at all.
 */
export const OS_TESTED_MAX: Readonly<Record<string, readonly [number, number]>> = { ubuntu: [24, 4], debian: [12, 0] };

export interface OsRelease {
  distro: string;
  major: number;
  minor: number;
}

/** `Ubuntu 26.04.1 LTS`, or `ubuntu` plus `26.04`: the distribution and the release, or null when the text names neither. */
export function parseOsRelease(os: string | null | undefined, version?: string | null): OsRelease | null {
  const text = `${os ?? ""} ${version ?? ""}`.toLowerCase();
  const distro = /\b(ubuntu|debian)\b/.exec(text)?.[1];
  if (!distro) return null;
  const rel = /(\d{1,3})(?:\.(\d{1,3}))?/.exec(text.slice(text.indexOf(distro) + distro.length)) ?? /(\d{1,3})(?:\.(\d{1,3}))?/.exec(text);
  if (!rel) return null;
  return { distro, major: Number(rel[1]), minor: rel[2] === undefined ? 0 : Number(rel[2]) };
}

/**
 * Only Ubuntu's minor number names a release (24.04 is not 24.10). Debian's does not: the agent reports Debian as its point
 * release (`12.9`), and every 12.x is the same tested release, so Debian is judged by its major alone.
 */
const MINOR_NAMES_RELEASE: ReadonlySet<string> = new Set(["ubuntu"]);

/** A release newer than the newest one tested for its distribution. */
export function isNewerThanTested(r: OsRelease | null): boolean {
  if (!r) return false;
  const max = OS_TESTED_MAX[r.distro];
  if (!max) return false;
  if (r.major !== max[0]) return r.major > max[0];
  return MINOR_NAMES_RELEASE.has(r.distro) && r.minor > max[1];
}

/** The label a check shows for a release (`ubuntu 26.04`). Built from the parsed numbers, never from the source's own text. */
export const osLabel = (r: OsRelease): string => (MINOR_NAMES_RELEASE.has(r.distro) ? `${r.distro} ${r.major}.${String(r.minor).padStart(2, "0")}` : `${r.distro} ${r.major}`);

/** The newest tested releases as one label (`ubuntu 24.04, debian 12`), for the check that flags a newer one. */
export const testedOsLabel = (): string =>
  Object.entries(OS_TESTED_MAX)
    .map(([distro, [major, minor]]) => osLabel({ distro, major, minor }))
    .join(", ");

export interface DiskReading {
  freeBytes: number;
  totalBytes: number;
  /** Seconds since the agent reported the numbers. */
  ageSec: number;
}

/** The reading of a metric row (`disk_used` / `disk_total`, bigint on the wire): null when the row says nothing usable about the disk. */
export function diskReadingOf(m: { diskUsed: bigint | number; diskTotal: bigint | number; ts: Date }, nowMs: number): DiskReading | null {
  const total = Number(m.diskTotal);
  const used = Number(m.diskUsed);
  if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0 || used < 0) return null;
  return { freeBytes: Math.max(0, total - used), totalBytes: total, ageSec: Math.max(0, Math.round((nowMs - m.ts.getTime()) / 1000)) };
}

/** Free space below the floor, or below its share of the disk. */
export const lowDisk = (d: Pick<DiskReading, "freeBytes" | "totalBytes">): boolean => d.freeBytes < TARGET_MIN_FREE_BYTES || (d.totalBytes > 0 && d.freeBytes < d.totalBytes * TARGET_MIN_FREE_FRACTION);

/** Bytes as GiB with one decimal, for a check's params. */
export const gib = (bytes: number): number => Math.round((bytes / GIB) * 10) / 10;

export interface HostClass {
  /** The host that carries the source's own control plane. */
  controlPlane: Array<{ name: string; items: number }>;
  /** Hosts with a high consecutive-failure count that carry something of this run. */
  flaky: Array<{ name: string; count: number }>;
  /** Hosts on a release newer than the newest tested one that carry something of this run. */
  newOs: Array<{ name: string; os: string }>;
  /** Hosts the run moves something off that report no operating system (it is checked when the agent enrols on the target side). */
  osUnknown: string[];
  /** Hosts with nothing of this run on them: skipped, not an error. */
  empty: string[];
  /** How many of the hosts reported an OS at all (zero means the source says nothing about it). */
  osReported: number;
}

/**
 * Classify the source hosts of a plan. `itemsByHost` counts the run's INCLUDED items per source server ref. A host the plan
 * lists but the run puts nothing on is `empty`; flaky and new-OS flags only matter for hosts the run actually moves.
 */
export function classifyHosts(hosts: readonly PreflightHost[], itemsByHost: ReadonlyMap<string, number>): HostClass {
  const out: HostClass = { controlPlane: [], flaky: [], newOs: [], osUnknown: [], empty: [], osReported: 0 };
  for (const h of hosts) {
    const name = h.name || h.ref;
    const items = itemsByHost.get(h.ref) ?? 0;
    const release = parseOsRelease(h.os);
    if (h.os) out.osReported += 1;
    if (h.controlPlane) out.controlPlane.push({ name, items });
    if (items === 0) {
      out.empty.push(name);
      continue;
    }
    if (h.unreachableCount !== undefined && h.unreachableCount >= FLAKY_UNREACHABLE_COUNT) out.flaky.push({ name, count: h.unreachableCount });
    if (release && isNewerThanTested(release)) out.newOs.push({ name, os: osLabel(release) });
    if (!h.os) out.osUnknown.push(name);
  }
  return out;
}

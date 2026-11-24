/** Minimum days of metrics before a size suggestion is made. */
export const RIGHTSIZE_MIN_DAYS = 14;
/** The window the suggestion is based on. */
export const RIGHTSIZE_WINDOW_DAYS = 14;

/** "Near its limit" thresholds (percent of the whole host / disk). */
export const NEAR_LIMIT_CPU_P95 = 85;
export const NEAR_LIMIT_MEM_P95 = 90;
export const NEAR_LIMIT_DISK = 90;

/** Headroom a suggested size must keep: p95 CPU at most 70% of its cores, p95 memory at most 75% of its RAM. */
const CPU_TARGET = 0.7;
const MEM_TARGET = 0.75;
/** A suggested size must also hold the busiest minute: peak memory under 90% of its RAM, peak CPU within its cores. */
const MEM_PEAK_TARGET = 0.9;
/** The OS sees a little less RAM than a plan names. */
const OS_RAM_FACTOR = 0.94;
const GIB = 1024 ** 3;

/** A saving smaller than this (minor units and percent of the current price) is not worth a move. */
export const MIN_SAVING_CENTS = 100;
export const MIN_SAVING_PCT = 0.1;

export interface UsageStats {
  /** Days between the oldest and newest rollup minute in the window. */
  daysCollected: number;
  cpuAvgPct: number;
  cpuP95Pct: number;
  cpuPeakPct: number;
  memP95Pct: number;
  memPeakPct: number;
  /** Bytes in use at the 95th percentile (what a smaller plan must hold). */
  memP95Bytes: number;
  memPeakBytes: number;
  diskUsedPct: number;
  diskUsedBytes: number;
}

export interface Candidate {
  slug: string;
  label: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  arch: string;
  monthlyCents: number;
  currency: string;
}

export interface CurrentSize {
  cores: number;
  memBytes: number;
  /** Nominal disk size of the current plan (GB); a plan with a smaller disk is never suggested (disks do not shrink). */
  diskGb: number;
  arch: string;
  /** Price of the current plan from the SAME price list the candidates come from; null when unknown. */
  comparableMonthlyCents: number | null;
  currency: string | null;
  /** Slug of the current plan, never suggested again. */
  planSlug: string | null;
}

export type AdviceKind = "learning" | "ok" | "downsize" | "near_limit";
export type AdviceReason = "cpu" | "memory" | "disk";

export interface Advice {
  kind: AdviceKind;
  reasons: AdviceReason[];
  target: Candidate | null;
  /** Positive = saves per month (downsize); negative = costs more (a bigger plan). Null when no price comparison is possible. */
  savingsCents: number | null;
  /** Bigger disk is part of the move (only a plan that grows the disk can fix a full disk). */
  upgradeDisk: boolean;
  /** The smaller plan exists, but its disk is smaller than this server's and disks do not shrink: it takes a new, smaller server. */
  diskBlocked: boolean;
}

const cheapest = (list: Candidate[]): Candidate | null =>
  list.length ? [...list].sort((a, b) => a.monthlyCents - b.monthlyCents || b.cores - a.cores || b.memoryGb - a.memoryGb || a.slug.localeCompare(b.slug))[0] : null;

/** Does the candidate hold the observed load with the headroom rules? */
export function fits(u: UsageStats, c: Candidate, currentCores: number): boolean {
  const p95Cores = (u.cpuP95Pct / 100) * currentCores;
  const peakCores = (u.cpuPeakPct / 100) * currentCores;
  if (c.cores * CPU_TARGET < p95Cores) return false;
  if (c.cores < peakCores) return false;
  const ram = c.memoryGb * GIB * OS_RAM_FACTOR;
  if (ram * MEM_TARGET < u.memP95Bytes) return false;
  if (ram * MEM_PEAK_TARGET < u.memPeakBytes) return false;
  return true;
}

/** Which "near the limit" reasons apply. */
export function limitReasons(u: UsageStats): AdviceReason[] {
  const r: AdviceReason[] = [];
  if (u.cpuP95Pct >= NEAR_LIMIT_CPU_P95) r.push("cpu");
  if (u.memP95Pct >= NEAR_LIMIT_MEM_P95) r.push("memory");
  if (u.diskUsedPct >= NEAR_LIMIT_DISK) r.push("disk");
  return r;
}

/**
 * The size advice for one server, from 14 days of usage. Pure.
 *  - fewer than RIGHTSIZE_MIN_DAYS of data: "learning" (no number is guessed from a short window);
 *  - near its limit (CPU p95, memory p95 or disk): "near_limit", with the cheapest bigger plan that fixes it, if one is known;
 *  - otherwise the cheapest plan that holds the load with headroom, same architecture, only when it saves at least
 *    MIN_SAVING_CENTS and MIN_SAVING_PCT: "downsize". A plan with a smaller disk than the server's is only offered when no
 *    in-place plan exists, flagged `diskBlocked` (disks do not shrink: it takes a new, smaller server);
 *  - else "ok".
 */
export function advise(usage: UsageStats | null, current: CurrentSize, candidates: readonly Candidate[]): Advice {
  if (!usage || usage.daysCollected < RIGHTSIZE_MIN_DAYS) return NONE("learning");
  const pool = candidates.filter((c) => c.arch === current.arch && c.slug !== current.planSlug && (current.currency === null || c.currency === current.currency));
  const delta = (c: Candidate): number | null => (current.comparableMonthlyCents === null ? null : current.comparableMonthlyCents - c.monthlyCents);

  const reasons = limitReasons(usage);
  if (reasons.length) {
    const needDisk = reasons.includes("disk");
    const bigger = pool.filter((c) => {
      if (needDisk) {
        // A full disk is only fixed by a plan with a bigger disk, big enough to bring usage back to about 70%.
        if (c.diskGb <= current.diskGb || c.diskGb * 0.93 < usage.diskUsedBytes / GIB / 0.7) return false;
      } else if (c.diskGb < current.diskGb) return false;
      const better = c.cores > current.cores || c.memoryGb * GIB * OS_RAM_FACTOR > current.memBytes || (needDisk && c.diskGb > current.diskGb);
      if (!better) return false;
      // CPU / memory reasons must really be relieved; a disk-only reason needs no CPU/RAM check.
      const cpuOk = !reasons.includes("cpu") || c.cores * CPU_TARGET >= (usage.cpuP95Pct / 100) * current.cores;
      const memOk = !reasons.includes("memory") || c.memoryGb * GIB * OS_RAM_FACTOR * MEM_TARGET >= usage.memP95Bytes;
      return cpuOk && memOk;
    });
    const target = cheapest(bigger);
    return { kind: "near_limit", reasons, target, savingsCents: target ? delta(target) : null, upgradeDisk: !!target && needDisk && target.diskGb > current.diskGb, diskBlocked: false };
  }

  if (current.comparableMonthlyCents === null) return NONE("ok");
  const price = current.comparableMonthlyCents;
  const worthIt = (c: Candidate) => price - c.monthlyCents >= MIN_SAVING_CENTS && price - c.monthlyCents >= price * MIN_SAVING_PCT;
  const cheaperAndFits = pool.filter((c) => fits(usage, c, current.cores) && c.monthlyCents < price);
  // First the moves a plan change can do (the disk is kept or grows), then, if none, the ones that need a new server.
  const inPlace = cheapest(cheaperAndFits.filter((c) => c.diskGb >= current.diskGb));
  if (inPlace && worthIt(inPlace)) return { kind: "downsize", reasons: [], target: inPlace, savingsCents: price - inPlace.monthlyCents, upgradeDisk: false, diskBlocked: false };
  const fresh = cheapest(cheaperAndFits.filter((c) => c.diskGb < current.diskGb));
  if (fresh && worthIt(fresh)) return { kind: "downsize", reasons: [], target: fresh, savingsCents: price - fresh.monthlyCents, upgradeDisk: false, diskBlocked: true };
  return NONE("ok");
}

const NONE = (kind: AdviceKind): Advice => ({ kind, reasons: [], target: null, savingsCents: null, upgradeDisk: false, diskBlocked: false });

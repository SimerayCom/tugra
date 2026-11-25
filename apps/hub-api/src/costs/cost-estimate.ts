import { SIMILAR_PROVIDER, snapshotFor, type PlanArch, type ProviderSnapshot, type SnapshotPlan } from "./price-snapshot.data";

/** What the hub knows about a host's size. Memory/disk are what the OS reports (a bit under the plan's nominal size). */
export interface HostSize {
  cores: number | null;
  memBytes: number | null;
  diskBytes?: number | null;
  /** "arm64" / "aarch64" etc. from the agent; used to keep an ARM host on ARM plans. */
  arch?: string | null;
}

/** An estimate from the host's OWN provider's list: the plan is that provider's plan. */
export interface CostEstimate {
  provider: string;
  basis: "list";
  planSlug: string;
  planLabel: string;
  monthlyCents: number;
  currency: string;
  /** Whether the snapshot rows of this provider were re-read on its snapshot date. */
  verified: boolean;
  /** True when this provider's list prices include VAT (unlike the others, which are net). */
  vatIncluded: boolean;
  /** The day this provider's rows were read. */
  snapshotDate: string;
}

/** A price of a similar size at another provider. Only ever shown as a muted comparison, never as this server's plan. */
export interface SimilarCost {
  provider: string;
  monthlyCents: number;
  currency: string;
  snapshotDate: string;
}

/** Why a host has no estimate. */
export type NoEstimateReason = "no_size" | "no_provider" | "no_list" | "no_plan";

const GIB = 1024 ** 3;
/** A plan more than this factor away from the host in CPU or memory is not "the host's plan": no estimate then. */
const MAX_FACTOR = 1.6;
const MAX_LOG_DISTANCE = Math.log(MAX_FACTOR);

export const isArm = (arch: string | null | undefined): boolean => /arm|aarch/i.test(arch ?? "");

/** Plan label: the plan's name (or upper-cased slug) with its resources, e.g. "CX23 · 2 vCPU · 4 GB · 40 GB". */
export function planLabel(p: Pick<SnapshotPlan, "slug" | "cores" | "memoryGb" | "diskGb"> & { name?: string }): string {
  return [p.name ?? p.slug.toUpperCase(), `${p.cores} vCPU`, `${p.memoryGb} GB`, p.diskGb === null ? null : `${p.diskGb} GB`].filter(Boolean).join(" · ");
}

const hostMemGb = (host: HostSize): number | null => (host.memBytes && host.memBytes > 0 ? (host.memBytes / GIB) * 1.06 : null);

/**
 * How far a plan is from the host, smaller = closer. Log ratios so "half" and "double" weigh the same; the OS reports
 * a little less memory and disk than the plan names, so the host is first scaled up to the nominal size.
 */
function distance(host: HostSize, plan: SnapshotPlan): number {
  const parts: Array<[number, number]> = []; // [weight, |log ratio|]
  if (host.cores && host.cores > 0) parts.push([1, Math.abs(Math.log(plan.cores / host.cores))]);
  const mem = hostMemGb(host);
  if (mem !== null) parts.push([1, Math.abs(Math.log(plan.memoryGb / mem))]);
  if (host.diskBytes && host.diskBytes > 0 && plan.diskGb !== null) parts.push([0.5, Math.abs(Math.log(plan.diskGb / ((host.diskBytes / GIB) * 1.1)))]);
  if (!parts.length) return Number.POSITIVE_INFINITY;
  return parts.reduce((a, [w, d]) => a + w * d, 0);
}

/** Within MAX_FACTOR of the host in every dimension the host reports (CPU and memory; disks can be extended, so not the disk). */
function closeEnough(host: HostSize, plan: SnapshotPlan): boolean {
  if (host.cores && host.cores > 0 && Math.abs(Math.log(plan.cores / host.cores)) > MAX_LOG_DISTANCE) return false;
  const mem = hostMemGb(host);
  if (mem !== null && Math.abs(Math.log(plan.memoryGb / mem)) > MAX_LOG_DISTANCE) return false;
  return true;
}

/** The closest plan of one list that is also a close fit (same architecture where the list has it); ties go to the cheaper plan. */
function closestPlan(snap: ProviderSnapshot, host: HostSize): SnapshotPlan | null {
  const wantArch: PlanArch = isArm(host.arch) ? "arm" : "x86";
  const pool = snap.plans.filter((pl) => pl.arch === wantArch);
  // A list without plans of the host's architecture cannot price this host.
  let best: SnapshotPlan | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const pl of pool) {
    if (!closeEnough(host, pl)) continue;
    const d = distance(host, pl);
    // Ties go to the cheaper plan, so the estimate never inflates a bill.
    if (d < bestD || (d === bestD && best && pl.monthlyCents < best.monthlyCents)) {
      best = pl;
      bestD = d;
    }
  }
  return best && Number.isFinite(bestD) ? best : null;
}

const hasSize = (host: HostSize): boolean => !!(host.cores && host.cores > 0) || !!(host.memBytes && host.memBytes > 0);

/**
 * Estimate a host's monthly price from the bundled public snapshot: the closest plan of the host's OWN provider list.
 * There is no stand-in list: a host of an unknown or unlisted provider has no estimate (see `similarCost` for a muted
 * comparison, and `noEstimateReason` for why), and neither has a host no plan of its provider comes close to.
 * Null when the host's size is unknown. Pure.
 */
export function estimateCost(provider: string | null | undefined, host: HostSize): CostEstimate | null {
  // A disk size alone says too little about a machine: need its CPU or memory.
  if (!hasSize(host)) return null;
  const snap = snapshotFor(provider);
  if (!snap) return null;
  const best = closestPlan(snap, host);
  if (!best) return null;
  return {
    provider: snap.provider,
    basis: "list",
    planSlug: best.slug,
    planLabel: planLabel(best),
    monthlyCents: best.monthlyCents,
    currency: snap.currency,
    verified: snap.verified,
    vatIncluded: snap.vatIncluded === true,
    snapshotDate: snap.date,
  };
}

/** Why `estimateCost` gave nothing for this host and provider; null when it gives an estimate. Pure. */
export function noEstimateReason(provider: string | null | undefined, host: HostSize): NoEstimateReason | null {
  if (!hasSize(host)) return "no_size";
  if (!provider) return "no_provider";
  if (!snapshotFor(provider)) return "no_list";
  return estimateCost(provider, host) ? null : "no_plan";
}

/** A price of a similar size on the comparison list, for a host whose own provider has no list. Null when none is close. Pure. */
export function similarCost(host: HostSize): SimilarCost | null {
  if (!hasSize(host)) return null;
  const snap = snapshotFor(SIMILAR_PROVIDER);
  const best = snap ? closestPlan(snap, host) : null;
  return snap && best ? { provider: snap.provider, monthlyCents: best.monthlyCents, currency: snap.currency, snapshotDate: snap.date } : null;
}

/** Decimal money the operator typed ("12.5") to integer minor units; null when it is not a plain non-negative number. */
export function toCents(amount: number): number | null {
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) return null;
  return Math.round(amount * 100);
}

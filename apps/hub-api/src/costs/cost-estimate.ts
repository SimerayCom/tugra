import { PRICE_SNAPSHOT_DATE, REFERENCE_PROVIDER, snapshotFor, type PlanArch, type SnapshotPlan } from "./price-snapshot.data";

/** What the hub knows about a host's size. Memory/disk are what the OS reports (a bit under the plan's nominal size). */
export interface HostSize {
  cores: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  /** "arm64" / "aarch64" etc. from the agent; used to keep an ARM host on ARM plans. */
  arch?: string | null;
}

export interface CostEstimate {
  /** The provider list the plan comes from. */
  provider: string;
  /** "list" = the host's own provider is in the snapshot; "reference" = it is not, so a reference list stands in. */
  basis: "list" | "reference";
  planSlug: string;
  planLabel: string;
  monthlyCents: number;
  currency: string;
  /** Whether the snapshot rows of this provider were re-read on the snapshot date. */
  verified: boolean;
  snapshotDate: string;
}

const GIB = 1024 ** 3;

export const isArm = (arch: string | null | undefined): boolean => /arm|aarch/i.test(arch ?? "");

/** Plan label: slug upper-cased with its resources, e.g. "CX23 · 2 vCPU · 4 GB · 40 GB". */
export function planLabel(p: Pick<SnapshotPlan, "slug" | "cores" | "memoryGb" | "diskGb">): string {
  return `${p.slug.toUpperCase()} · ${p.cores} vCPU · ${p.memoryGb} GB · ${p.diskGb} GB`;
}

/**
 * How far a plan is from the host, smaller = closer. Log ratios so "half" and "double" weigh the same; the OS reports
 * a little less memory and disk than the plan names, so the host is first scaled up to the nominal size.
 */
function distance(host: HostSize, plan: SnapshotPlan): number {
  const parts: Array<[number, number]> = []; // [weight, |log ratio|]
  if (host.cores && host.cores > 0) parts.push([1, Math.abs(Math.log(plan.cores / host.cores))]);
  if (host.memBytes && host.memBytes > 0) parts.push([1, Math.abs(Math.log(plan.memoryGb / ((host.memBytes / GIB) * 1.06)))]);
  if (host.diskBytes && host.diskBytes > 0) parts.push([0.5, Math.abs(Math.log(plan.diskGb / ((host.diskBytes / GIB) * 1.1)))]);
  if (!parts.length) return Number.POSITIVE_INFINITY;
  return parts.reduce((a, [w, d]) => a + w * d, 0);
}

/**
 * Estimate a host's monthly price from the bundled public snapshot: the closest plan of the host's own provider, or
 * of the reference list when the provider is unknown or not in the snapshot. Null when the host's size is unknown.
 * Pure.
 */
export function estimateCost(provider: string | null | undefined, host: HostSize): CostEstimate | null {
  // A disk size alone says too little about a machine: need its CPU or memory.
  if (!(host.cores && host.cores > 0) && !(host.memBytes && host.memBytes > 0)) return null;
  const own = snapshotFor(provider);
  const snap = own ?? snapshotFor(REFERENCE_PROVIDER);
  if (!snap) return null;
  const wantArch: PlanArch = isArm(host.arch) ? "arm" : "x86";
  const pool = snap.plans.filter((pl) => pl.arch === wantArch);
  let best: SnapshotPlan | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const pl of pool.length ? pool : snap.plans) {
    const d = distance(host, pl);
    // Ties go to the cheaper plan, so the estimate never inflates a bill.
    if (d < bestD || (d === bestD && best && pl.monthlyCents < best.monthlyCents)) {
      best = pl;
      bestD = d;
    }
  }
  if (!best || !Number.isFinite(bestD)) return null;
  return {
    provider: snap.provider,
    basis: own ? "list" : "reference",
    planSlug: best.slug,
    planLabel: planLabel(best),
    monthlyCents: best.monthlyCents,
    currency: snap.currency,
    verified: snap.verified,
    snapshotDate: PRICE_SNAPSHOT_DATE,
  };
}

/** Decimal money the operator typed ("12.5") to integer minor units; null when it is not a plain non-negative number. */
export function toCents(amount: number): number | null {
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) return null;
  return Math.round(amount * 100);
}

/** Costs, size advice and rescale: wire types (mirror the hub's costs DTOs) and the pure helpers the screens share. */

export type CostSource = "provider" | "manual" | "estimate" | "unknown";

export type UnknownReason = "no_size" | "no_provider" | "no_list" | "no_plan";

export interface CostAppShare {
  key: string;
  kind: "app" | "db" | "system" | "other";
  resourceId: string | null;
  name: string;
  sharePct: number;
  cents: number;
}

export interface ServerCostView {
  serverId: string;
  name: string;
  monthlyCents: number | null;
  currency: string | null;
  source: CostSource;
  provider: string | null;
  /** Where `provider` came from: a link, the host's agent, or a guess from the host name (a hint the price can replace). */
  providerHint: "linked" | "agent" | "hostname" | null;
  planSlug: string | null;
  planLabel: string | null;
  /** Estimates only: the plan is from the host's own provider list. */
  estimateBasis: "list" | null;
  snapshotVerified: boolean | null;
  /** Estimates only: the day that provider's list was read. */
  snapshotDate: string | null;
  /** Unknown prices only: why there is no estimate. */
  unknownReason: UnknownReason | null;
  /** Unknown prices only: a muted comparison from another provider's public list; never this server's plan. */
  similar: { provider: string; monthlyCents: number; currency: string; snapshotDate: string } | null;
  syncedAt: string | null;
  canSync: boolean;
  cores: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  apps: CostAppShare[];
}

export interface CostTotal {
  currency: string;
  monthlyCents: number;
  estimatedCents: number;
  servers: number;
}

export interface CostBaseline {
  id: string;
  label: string;
  monthlyCents: number;
  currency: string;
  createdAt: string;
  servers: number;
}

export interface CostComparison {
  baseline: CostBaseline;
  currency: string;
  beforeCents: number;
  afterCents: number;
  deltaCents: number;
  deltaPct: number;
  yearlyDeltaCents: number;
  includesEstimates: boolean;
}

export interface TeamCost {
  teamId: string;
  teamName: string;
  canManage: boolean;
  canOps: boolean;
  totals: CostTotal[];
  servers: ServerCostView[];
  baselines: CostBaseline[];
  comparison: CostComparison | null;
  snapshotDate: string;
}

export interface CostsReport {
  teams: TeamCost[];
}

export interface CostSyncResult {
  synced: number;
  failed: Array<{ credentialName: string; message: string }>;
}

export type AdviceKind = "learning" | "ok" | "downsize" | "near_limit";
export type AdviceReason = "cpu" | "memory" | "disk";

export interface AdvicePlan {
  slug: string;
  label: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  monthlyCents: number;
  currency: string;
}

export interface ServerAdvice {
  serverId: string;
  name: string;
  teamId: string;
  kind: AdviceKind;
  reasons: AdviceReason[];
  daysCollected: number;
  daysNeeded: number;
  usage: { cpuAvgPct: number; cpuP95Pct: number; memP95Pct: number; diskUsedPct: number } | null;
  provider: string | null;
  current: { slug: string | null; label: string | null; cores: number; memoryGb: number; diskGb: number; monthlyCents: number | null; currency: string | null } | null;
  target: AdvicePlan | null;
  savingsCents: number | null;
  priceBasis: "provider" | "list" | "none";
  upgradeDisk: boolean;
  diskBlocked: boolean;
  rescale: "api" | "guide";
  rescaleBlocked: "local_hub" | "active" | null;
}

export interface AdviceReport {
  advice: ServerAdvice[];
  snapshotDate: string;
}

export type RescalePhase = "SHUTTING_DOWN" | "RESIZING" | "POWERING_ON" | "DONE" | "FAILED";

export interface RescaleView {
  id: string;
  serverId: string;
  provider: string;
  fromPlan: string;
  toPlan: string;
  phase: RescalePhase;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Money in integer minor units to a short, locale-aware string ("€5.99", "$24"). Whole amounts drop the decimals. */
export function formatMoney(cents: number, currency: string): string {
  const whole = Math.abs(cents) % 100 === 0;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(whole ? 0 : 2)} ${currency}`;
  }
}

const PROVIDER_NAMES: Record<string, string> = {
  hetzner: "Hetzner",
  digitalocean: "DigitalOcean",
  vultr: "Vultr",
  aws: "AWS",
  gcp: "Google Cloud",
  azure: "Azure",
  oracle: "Oracle Cloud",
  ovh: "OVHcloud",
  contabo: "Contabo",
  linode: "Akamai (Linode)",
  netcup: "netcup",
  ionos: "IONOS",
  scaleway: "Scaleway",
  upcloud: "UpCloud",
};

/** A provider slug as a display name; null stays null. */
export function providerName(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return PROVIDER_NAMES[slug] ?? slug;
}

/** Which step-by-step guide to show for a provider (the ones with their own wording, else the generic one). */
export function guideKey(provider: string | null | undefined): "hetzner" | "digitalocean" | "vultr" | "generic" {
  return provider === "hetzner" || provider === "digitalocean" || provider === "vultr" ? provider : "generic";
}

const PHASES: RescalePhase[] = ["SHUTTING_DOWN", "RESIZING", "POWERING_ON", "DONE"];
/** 0..3 step reached by a rescale (FAILED keeps the step it stopped at: unknown here, so -1). */
export function rescaleStep(phase: RescalePhase): number {
  return PHASES.indexOf(phase);
}
export const rescaleActive = (phase: RescalePhase | undefined): boolean => phase === "SHUTTING_DOWN" || phase === "RESIZING" || phase === "POWERING_ON";

/** Percent rounded for display ("12%"), clamped to 0..100+. */
export const pct = (n: number): string => `${Math.max(0, Math.round(n))}%`;

/** Parse what a person typed as a monthly price ("12.5", "12,50"); null when it is not a usable non-negative number. */
export function parseMoneyInput(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** A server's plan size as a short line: "4 vCPU · 8 GB RAM · 160 GB". */
export function sizeLine(cores: number | null, memBytes: number | null, diskBytes: number | null): string {
  const gib = 1024 ** 3;
  const parts: string[] = [];
  if (cores) parts.push(`${cores} vCPU`);
  if (memBytes) parts.push(`${Math.round((memBytes / gib) * 10) / 10 >= 10 ? Math.round(memBytes / gib) : Math.round((memBytes / gib) * 10) / 10} GB RAM`);
  if (diskBytes) parts.push(`${Math.round(diskBytes / gib)} GB`);
  return parts.join(" · ");
}

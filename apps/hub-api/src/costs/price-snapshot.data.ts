/**
 * Bundled PUBLIC price snapshot, used only to ESTIMATE a server's monthly price when no provider API is connected
 * (the number is always shown as an estimate the operator can correct). List prices excluding VAT, integer minor
 * units. Refresh this file by hand from the providers' public price pages and bump the date; nothing here is fetched
 * at run time, and nothing here is a quote.
 *
 *  - hetzner: hetzner.com/cloud plan pages, read 2026-11-24, EU list price (Helsinki; the German locations are
 *    slightly higher, and US/Singapore differ). Only the EU plan lines are listed.
 *  - digitalocean: digitalocean.com/pricing/droplets (Basic), read 2026-11-24.
 *  - vultr: Cloud Compute regular plans from the provider's published list; NOT re-read on the snapshot date
 *    (`verified: false`), so the UI says the figure may be out of date.
 */
export const PRICE_SNAPSHOT_DATE = "2026-11-24";

export type PlanArch = "x86" | "arm";

export interface SnapshotPlan {
  slug: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  arch: PlanArch;
  monthlyCents: number;
}

export interface ProviderSnapshot {
  provider: string;
  label: string;
  currency: string;
  /** false = this provider's rows were not re-read on PRICE_SNAPSHOT_DATE. */
  verified: boolean;
  plans: readonly SnapshotPlan[];
}

const p = (slug: string, cores: number, memoryGb: number, diskGb: number, monthlyCents: number, arch: PlanArch = "x86"): SnapshotPlan => ({
  slug,
  cores,
  memoryGb,
  diskGb,
  arch,
  monthlyCents,
});

export const PRICE_SNAPSHOT: readonly ProviderSnapshot[] = [
  {
    provider: "hetzner",
    label: "Hetzner",
    currency: "EUR",
    verified: true,
    plans: [
      p("cx23", 2, 4, 40, 599),
      p("cx33", 4, 8, 80, 899),
      p("cx43", 8, 16, 160, 1649),
      p("cx53", 16, 32, 320, 2999),
      p("cax11", 2, 4, 40, 649, "arm"),
      p("cax21", 4, 8, 80, 1099, "arm"),
      p("cax31", 8, 16, 160, 2149, "arm"),
      p("cax41", 16, 32, 320, 4149, "arm"),
      p("cpx12", 1, 2, 40, 999),
      p("cpx22", 2, 4, 80, 1699),
      p("cpx32", 4, 8, 160, 3049),
      p("cpx42", 8, 16, 320, 5949),
      p("cpx52", 12, 24, 480, 8549),
      p("cpx62", 16, 32, 640, 11099),
      p("ccx13", 2, 8, 80, 3699),
      p("ccx23", 4, 16, 160, 7349),
      p("ccx33", 8, 32, 240, 11799),
      p("ccx43", 16, 64, 360, 23499),
      p("ccx53", 32, 128, 600, 45349),
      p("ccx63", 48, 192, 960, 72549),
    ],
  },
  {
    provider: "digitalocean",
    label: "DigitalOcean",
    currency: "USD",
    verified: true,
    plans: [
      p("s-1vcpu-1gb", 1, 1, 25, 600),
      p("s-1vcpu-2gb", 1, 2, 50, 1200),
      p("s-2vcpu-2gb", 2, 2, 60, 1800),
      p("s-2vcpu-4gb", 2, 4, 80, 2400),
      p("s-4vcpu-8gb", 4, 8, 160, 4800),
      p("s-8vcpu-16gb", 8, 16, 320, 9600),
    ],
  },
  {
    provider: "vultr",
    label: "Vultr",
    currency: "USD",
    verified: false,
    plans: [
      p("vc2-1c-1gb", 1, 1, 25, 500),
      p("vc2-1c-2gb", 1, 2, 55, 1000),
      p("vc2-2c-4gb", 2, 4, 80, 2000),
      p("vc2-4c-8gb", 4, 8, 160, 4000),
      p("vc2-6c-16gb", 6, 16, 320, 8000),
      p("vc2-8c-32gb", 8, 32, 640, 16000),
    ],
  },
];

/** The provider whose list stands in for a host of an unknown or unlisted provider ("reference list"). */
export const REFERENCE_PROVIDER = "hetzner";

export const snapshotFor = (provider: string | null | undefined): ProviderSnapshot | undefined =>
  PRICE_SNAPSHOT.find((s) => s.provider === provider);

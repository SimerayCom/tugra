/**
 * Bundled PUBLIC price snapshot, used only to ESTIMATE a server's monthly price when no provider API is connected
 * (the number is always shown as an estimate the operator can correct). Integer minor units. Refresh this file by
 * hand from the providers' public price pages and bump the date; nothing here is fetched at run time, and nothing
 * here is a quote. Each provider carries its own read date and the URL it was read from.
 *
 * VAT: figures are net of VAT unless a provider's `vatIncluded` flag says otherwise (Contabo, see its note below). Promotional and long-commitment
 * discounts are NOT applied: where a page shows a struck-through regular price next to a discounted one, the regular
 * price is listed. One-time setup fees, backups, extra storage and extra IPs are not included.
 *
 *  - hetzner: hetzner.com/cloud plan pages, EU list price (Helsinki; the German locations are slightly higher, and
 *    US/Singapore differ). Only the EU plan lines are listed.
 *  - digitalocean: digitalocean.com/pricing/droplets (Basic).
 *  - vultr: Cloud Compute regular plans, read from Vultr's public plan list (api.vultr.com/v2/plans). A few regions
 *    are priced higher; the standard price is listed.
 *  - contabo: contabo.com/en/vps, Cloud VPS line. The struck-through monthly price is listed (the 24-month term price
 *    is lower). Read 2026-11-25: the page's footnote says the price shown includes applicable taxes, at the rate of
 *    the visitor's tax country (it has an Including/Excluding VAT toggle). The rate is not known here, so the rows
 *    are NOT converted to net: the snapshot carries `vatIncluded: true` and the estimate says so. Where a plan offers
 *    SSD or NVMe, the SSD size is listed.
 *  - ovh: ovhcloud.com/en-ie/vps (EUR, "ex. VAT"); the "from" price of the four current VPS plans.
 *  - netcup: netcup.com/en/server/vps, VPS G12.5 line. The page shows VAT-inclusive prices (19%); the regular
 *    (struck-through) price is divided by 1.19 and rounded.
 *  - linode: Akamai/Linode shared-CPU plans (Nanode and Linode shared), from the public Linode API types list
 *    (api.linode.com/v4/linode/types, USD, no VAT), standard US price.
 *  - scaleway: Scaleway's public product catalog (api.scaleway.com/product-catalog), General Purpose range
 *    BASIC3 (x86) and BASIC2 (arm), fr-par-1, EUR excl. VAT. Hourly price x 730 hours. Instance only: block storage is
 *    billed separately, so the disk size is not listed.
 *  - ionos: ionos.co.uk/servers/vps, VPS S+/M+/L+/XL+ (GBP, "excl. VAT"); the one-time GBP 10 setup fee is not included.
 *
 *  NOT listed: UpCloud. Its pricing page is not readable without a browser (it answers automated requests with a
 *  challenge) and the numbers behind its price calculator could not be tied to a unit with confidence.
 */
export const PRICE_SNAPSHOT_DATE = "2026-11-25";

export type PlanArch = "x86" | "arm";

export interface SnapshotPlan {
  slug: string;
  /** Display name when the upper-cased slug is not it (e.g. "Cloud VPS 12"). */
  name?: string;
  cores: number;
  memoryGb: number;
  /** Null when the plan has no local disk (storage is bought separately). */
  diskGb: number | null;
  arch: PlanArch;
  monthlyCents: number;
}

export interface ProviderSnapshot {
  provider: string;
  label: string;
  /** The day this provider's rows were read. */
  date: string;
  /** The public page or API the rows were read from. */
  sourceUrl: string;
  currency: string;
  /** false = this provider's rows were not re-read on PRICE_SNAPSHOT_DATE. */
  verified: boolean;
  /** true = the rows include VAT at an unknown rate and could not be made net; absent = net of VAT. */
  vatIncluded?: boolean;
  plans: readonly SnapshotPlan[];
}

const p = (slug: string, cores: number, memoryGb: number, diskGb: number | null, monthlyCents: number, arch: PlanArch = "x86", name?: string): SnapshotPlan => ({
  slug,
  ...(name ? { name } : {}),
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
    date: "2026-11-24",
    sourceUrl: "https://www.hetzner.com/cloud",
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
    date: "2026-11-24",
    sourceUrl: "https://www.digitalocean.com/pricing/droplets",
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
    date: "2026-11-25",
    sourceUrl: "https://api.vultr.com/v2/plans",
    currency: "USD",
    verified: true,
    plans: [
      p("vc2-1c-1gb", 1, 1, 25, 500),
      p("vc2-1c-2gb", 1, 2, 55, 1000),
      p("vc2-2c-4gb", 2, 4, 80, 2000),
      p("vc2-4c-8gb", 4, 8, 160, 4000),
      p("vc2-6c-16gb", 6, 16, 320, 8000),
      p("vc2-8c-32gb", 8, 32, 640, 16000),
    ],
  },
  {
    provider: "contabo",
    label: "Contabo",
    date: "2026-11-25",
    sourceUrl: "https://contabo.com/en/vps/",
    currency: "EUR",
    verified: true,
    vatIncluded: true,
    plans: [
      p("cloud-vps-4", 4, 8, 100, 550, "x86", "Cloud VPS 4"),
      p("cloud-vps-6", 6, 12, 200, 750, "x86", "Cloud VPS 6"),
      p("cloud-vps-8", 8, 24, 300, 1400, "x86", "Cloud VPS 8"),
      p("cloud-vps-12", 12, 48, 400, 2500, "x86", "Cloud VPS 12"),
      p("cloud-vps-16", 16, 64, 500, 3700, "x86", "Cloud VPS 16"),
      p("cloud-vps-18", 18, 96, 600, 4900, "x86", "Cloud VPS 18"),
    ],
  },
  {
    provider: "ovh",
    label: "OVHcloud",
    date: "2026-11-25",
    sourceUrl: "https://www.ovhcloud.com/en-ie/vps/",
    currency: "EUR",
    verified: true,
    plans: [
      p("vps-1", 2, 4, 40, 381, "x86", "VPS-1"),
      p("vps-2", 4, 8, 75, 721, "x86", "VPS-2"),
      p("vps-3", 6, 12, 100, 1040, "x86", "VPS-3"),
      p("vps-4", 8, 24, 200, 1996, "x86", "VPS-4"),
    ],
  },
  {
    provider: "netcup",
    label: "netcup",
    date: "2026-11-25",
    sourceUrl: "https://www.netcup.com/en/server/vps",
    currency: "EUR",
    verified: true,
    plans: [
      p("vps-500-g12-5", 2, 4, 64, 798, "x86", "VPS 500 G12.5"),
      p("vps-1000-g12-5", 4, 8, 128, 1402, "x86", "VPS 1000 G12.5"),
      p("vps-2000-g12-5", 8, 16, 256, 2602, "x86", "VPS 2000 G12.5"),
      p("vps-4000-g12-5", 12, 32, 512, 4383, "x86", "VPS 4000 G12.5"),
      p("vps-8000-g12-5", 16, 64, 1024, 6484, "x86", "VPS 8000 G12.5"),
    ],
  },
  {
    provider: "linode",
    label: "Akamai (Linode)",
    date: "2026-11-25",
    sourceUrl: "https://api.linode.com/v4/linode/types",
    currency: "USD",
    verified: true,
    plans: [
      p("g6-nanode-1", 1, 1, 25, 500, "x86", "Nanode 1 GB"),
      p("g6-standard-1", 1, 2, 50, 1200, "x86", "Linode 2 GB"),
      p("g6-standard-2", 2, 4, 80, 2400, "x86", "Linode 4 GB"),
      p("g6-standard-4", 4, 8, 160, 4800, "x86", "Linode 8 GB"),
      p("g6-standard-6", 6, 16, 320, 9600, "x86", "Linode 16 GB"),
      p("g6-standard-8", 8, 32, 640, 19200, "x86", "Linode 32 GB"),
      p("g6-standard-16", 16, 64, 1280, 38400, "x86", "Linode 64 GB"),
      p("g6-standard-20", 20, 96, 1920, 57600, "x86", "Linode 96 GB"),
      p("g6-standard-24", 24, 128, 2560, 76800, "x86", "Linode 128 GB"),
      p("g6-standard-32", 32, 192, 3840, 115200, "x86", "Linode 192 GB"),
    ],
  },
  {
    provider: "scaleway",
    label: "Scaleway",
    date: "2026-11-25",
    sourceUrl: "https://api.scaleway.com/product-catalog/v2alpha1/public-catalog/products?product_types=instance",
    currency: "EUR",
    verified: true,
    plans: [
      p("basic3-x2c-4g", 2, 4, null, 2880, "x86", "BASIC3-X2C-4G"),
      p("basic3-x2c-8g", 2, 8, null, 4323, "x86", "BASIC3-X2C-8G"),
      p("basic3-x4c-8g", 4, 8, null, 5767, "x86", "BASIC3-X4C-8G"),
      p("basic3-x4c-16g", 4, 16, null, 8647, "x86", "BASIC3-X4C-16G"),
      p("basic3-x6c-12g", 6, 12, null, 9899, "x86", "BASIC3-X6C-12G"),
      p("basic3-x6c-24g", 6, 24, null, 11337, "x86", "BASIC3-X6C-24G"),
      p("basic3-x8c-16g", 8, 16, null, 12970, "x86", "BASIC3-X8C-16G"),
      p("basic3-x8c-32g", 8, 32, null, 17286, "x86", "BASIC3-X8C-32G"),
      p("basic3-x12c-24g", 12, 24, null, 19790, "x86", "BASIC3-X12C-24G"),
      p("basic3-x12c-48g", 12, 48, null, 22659, "x86", "BASIC3-X12C-48G"),
      p("basic3-x16c-32g", 16, 32, null, 25933, "x86", "BASIC3-X16C-32G"),
      p("basic3-x16c-64g", 16, 64, null, 34550, "x86", "BASIC3-X16C-64G"),
      p("basic2-a2c-4g", 2, 4, null, 1679, "arm", "BASIC2-A2C-4G"),
      p("basic2-a2c-8g", 2, 8, null, 2518, "arm", "BASIC2-A2C-8G"),
      p("basic2-a4c-8g", 4, 8, null, 3774, "arm", "BASIC2-A4C-8G"),
      p("basic2-a4c-16g", 4, 16, null, 5030, "arm", "BASIC2-A4C-16G"),
      p("basic2-a6c-12g", 6, 12, null, 5760, "arm", "BASIC2-A6C-12G"),
      p("basic2-a6c-24g", 6, 24, null, 6592, "arm", "BASIC2-A6C-24G"),
      p("basic2-a8c-16g", 8, 16, null, 7548, "arm", "BASIC2-A8C-16G"),
      p("basic2-a8c-32g", 8, 32, null, 10059, "arm", "BASIC2-A8C-32G"),
      p("basic2-a12c-24g", 12, 24, null, 11519, "arm", "BASIC2-A12C-24G"),
      p("basic2-a12c-48g", 12, 48, null, 13191, "arm", "BASIC2-A12C-48G"),
      p("basic2-a16c-32g", 16, 32, null, 15089, "arm", "BASIC2-A16C-32G"),
      p("basic2-a16c-64g", 16, 64, null, 20119, "arm", "BASIC2-A16C-64G"),
    ],
  },
  {
    provider: "ionos",
    label: "IONOS",
    date: "2026-11-25",
    sourceUrl: "https://www.ionos.co.uk/servers/vps",
    currency: "GBP",
    verified: true,
    plans: [
      p("vps-s-plus", 1, 2, 60, 500, "x86", "VPS S+"),
      p("vps-m-plus", 2, 4, 120, 1200, "x86", "VPS M+"),
      p("vps-l-plus", 4, 8, 240, 2200, "x86", "VPS L+"),
      p("vps-xl-plus", 8, 16, 480, 4100, "x86", "VPS XL+"),
    ],
  },
];

/** The provider whose list is shown as a muted "similar size" comparison for a host of an unknown or unlisted provider. */
export const SIMILAR_PROVIDER = "hetzner";

export const snapshotFor = (provider: string | null | undefined): ProviderSnapshot | undefined =>
  PRICE_SNAPSHOT.find((s) => s.provider === provider);

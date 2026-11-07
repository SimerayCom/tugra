/**
 * Curated Vultr region / plan / OS options offered when provisioning. Hardcoded (no live API
 * listing yet) — a small, stable set; validated server-side against a raw API caller.
 * `value` is the CURATED key the API/CLI/UI use; `providerValue` is what Vultr's API expects
 * (images map to numeric `os_id`s).
 */
export const VULTR_LOCATIONS = [
  { value: "ewr", label: "New Jersey, US", providerValue: "ewr" },
  { value: "lax", label: "Los Angeles, US", providerValue: "lax" },
  { value: "ams", label: "Amsterdam, NL", providerValue: "ams" },
  { value: "fra", label: "Frankfurt, DE", providerValue: "fra" },
  { value: "lhr", label: "London, UK", providerValue: "lhr" },
  { value: "sgp", label: "Singapore", providerValue: "sgp" },
] as const;

export const VULTR_SERVER_TYPES = [
  { value: "vc2-1c-2gb", label: "Cloud Compute — 1 vCPU · 2 GB RAM · 55 GB", providerValue: "vc2-1c-2gb" },
  { value: "vc2-2c-4gb", label: "Cloud Compute — 2 vCPU · 4 GB RAM · 80 GB", providerValue: "vc2-2c-4gb" },
  { value: "vc2-4c-8gb", label: "Cloud Compute — 4 vCPU · 8 GB RAM · 160 GB", providerValue: "vc2-4c-8gb" },
] as const;

export const VULTR_IMAGES = [
  { value: "ubuntu-24.04", label: "Ubuntu 24.04", providerValue: 2284 },
  { value: "ubuntu-22.04", label: "Ubuntu 22.04", providerValue: 1743 },
  { value: "debian-12", label: "Debian 12", providerValue: 2136 },
] as const;

export const VULTR_DEFAULT_IMAGE = "ubuntu-24.04";

export const vultrRegion = (key: string): string | undefined => VULTR_LOCATIONS.find((e) => e.value === key)?.providerValue;
export const vultrPlan = (key: string): string | undefined => VULTR_SERVER_TYPES.find((e) => e.value === key)?.providerValue;
export const vultrOsId = (key: string): number | undefined => VULTR_IMAGES.find((e) => e.value === key)?.providerValue;

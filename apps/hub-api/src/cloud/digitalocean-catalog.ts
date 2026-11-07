/**
 * Curated DigitalOcean region / droplet-size / image options offered when provisioning. Hardcoded
 * (no live API listing yet) — a small, stable set; validated server-side against a raw API caller.
 * `value` is the CURATED key the API/CLI/UI use; `providerValue` is what DigitalOcean's API expects.
 */
export const DIGITALOCEAN_LOCATIONS = [
  { value: "nyc3", label: "New York 3, US", providerValue: "nyc3" },
  { value: "sfo3", label: "San Francisco 3, US", providerValue: "sfo3" },
  { value: "ams3", label: "Amsterdam 3, NL", providerValue: "ams3" },
  { value: "fra1", label: "Frankfurt 1, DE", providerValue: "fra1" },
  { value: "lon1", label: "London 1, UK", providerValue: "lon1" },
  { value: "sgp1", label: "Singapore 1", providerValue: "sgp1" },
] as const;

export const DIGITALOCEAN_SERVER_TYPES = [
  { value: "s-1vcpu-2gb", label: "Basic — 1 vCPU · 2 GB RAM · 50 GB", providerValue: "s-1vcpu-2gb" },
  { value: "s-2vcpu-4gb", label: "Basic — 2 vCPU · 4 GB RAM · 80 GB", providerValue: "s-2vcpu-4gb" },
  { value: "s-4vcpu-8gb", label: "Basic — 4 vCPU · 8 GB RAM · 160 GB", providerValue: "s-4vcpu-8gb" },
] as const;

export const DIGITALOCEAN_IMAGES = [
  { value: "ubuntu-24.04", label: "Ubuntu 24.04", providerValue: "ubuntu-24-04-x64" },
  { value: "ubuntu-22.04", label: "Ubuntu 22.04", providerValue: "ubuntu-22-04-x64" },
  { value: "debian-12", label: "Debian 12", providerValue: "debian-12-x64" },
] as const;

export const DIGITALOCEAN_DEFAULT_IMAGE = "ubuntu-24.04";

type Entry = { readonly value: string; readonly providerValue: string };
const lookup = (list: readonly Entry[], key: string): string | undefined => list.find((e) => e.value === key)?.providerValue;

export const digitalOceanRegion = (key: string): string | undefined => lookup(DIGITALOCEAN_LOCATIONS, key);
export const digitalOceanSize = (key: string): string | undefined => lookup(DIGITALOCEAN_SERVER_TYPES, key);
export const digitalOceanImage = (key: string): string | undefined => lookup(DIGITALOCEAN_IMAGES, key);

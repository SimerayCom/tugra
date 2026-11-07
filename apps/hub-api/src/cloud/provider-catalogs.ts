import { HETZNER_DEFAULT_IMAGE, HETZNER_IMAGES, HETZNER_LOCATIONS, HETZNER_SERVER_TYPES } from "./hetzner-catalog";
import { DIGITALOCEAN_DEFAULT_IMAGE, DIGITALOCEAN_IMAGES, DIGITALOCEAN_LOCATIONS, DIGITALOCEAN_SERVER_TYPES } from "./digitalocean-catalog";
import { VULTR_DEFAULT_IMAGE, VULTR_IMAGES, VULTR_LOCATIONS, VULTR_SERVER_TYPES } from "./vultr-catalog";

interface CatalogEntry {
  readonly value: string;
}
export interface ProviderCatalog {
  locations: readonly CatalogEntry[];
  serverTypes: readonly CatalogEntry[];
  images: readonly CatalogEntry[];
  defaultImage: string;
}

const CATALOGS: Record<string, ProviderCatalog> = {
  hetzner: { locations: HETZNER_LOCATIONS, serverTypes: HETZNER_SERVER_TYPES, images: HETZNER_IMAGES, defaultImage: HETZNER_DEFAULT_IMAGE },
  digitalocean: { locations: DIGITALOCEAN_LOCATIONS, serverTypes: DIGITALOCEAN_SERVER_TYPES, images: DIGITALOCEAN_IMAGES, defaultImage: DIGITALOCEAN_DEFAULT_IMAGE },
  vultr: { locations: VULTR_LOCATIONS, serverTypes: VULTR_SERVER_TYPES, images: VULTR_IMAGES, defaultImage: VULTR_DEFAULT_IMAGE },
};

/** The curated catalog for a provider, or undefined for a provider with no client. */
export const catalogFor = (provider: string): ProviderCatalog | undefined => CATALOGS[provider];

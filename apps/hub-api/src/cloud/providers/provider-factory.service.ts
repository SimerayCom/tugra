import { BadRequestException, Injectable } from "@nestjs/common";
import type { CloudOobProvider, CloudPlanProvider, CloudPriceReader, CloudProvider } from "./cloud-provider.interface";
import { HetznerApiClient } from "./hetzner.client";
import { DigitalOceanApiClient } from "./digitalocean.client";
import { VultrApiClient } from "./vultr.client";

/** Maps a provider name → its client. A new provider is added purely by implementing its client +
 *  extending this switch (plus its curated catalog in provider-catalogs.ts). */
@Injectable()
export class CloudProviderFactory {
  constructor(
    private readonly hetzner: HetznerApiClient,
    private readonly digitalocean: DigitalOceanApiClient,
    private readonly vultr: VultrApiClient,
  ) {}

  get(provider: string): CloudProvider {
    if (provider === "hetzner") return this.hetzner;
    if (provider === "digitalocean") return this.digitalocean;
    if (provider === "vultr") return this.vultr;
    throw new BadRequestException(`provider not yet supported: ${provider}`);
  }

  /** The provider's out-of-band client (power / rescue / console), or null when it has none yet. Hetzner only
   *  for now; DigitalOcean and Vultr stay provisioning-only until their console/rescue APIs are verified. */
  getOob(provider: string): CloudOobProvider | null {
    return provider === "hetzner" ? this.hetzner : null;
  }

  /** The provider's plan/price client (plan prices from its API, change a VM's plan), or null when it has none yet. */
  getPlans(provider: string): CloudPlanProvider | null {
    return provider === "hetzner" ? this.hetzner : null;
  }

  /** The provider's read-only price client (what a linked VM costs per month from the provider's API), or null when it has none. */
  getPrices(provider: string): CloudPriceReader | null {
    if (provider === "hetzner") return this.hetzner;
    if (provider === "digitalocean") return this.digitalocean;
    if (provider === "vultr") return this.vultr;
    return null;
  }
}

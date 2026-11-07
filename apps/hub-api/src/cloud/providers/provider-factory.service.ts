import { BadRequestException, Injectable } from "@nestjs/common";
import type { CloudProvider } from "./cloud-provider.interface";
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
}

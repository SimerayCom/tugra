import { BadRequestException, Injectable } from "@nestjs/common";
import type { CloudProvider } from "./cloud-provider.interface";
import { HetznerApiClient } from "./hetzner.client";

/** Maps a provider name → its client. v1 supports Hetzner only; DigitalOcean/Vultr are added purely
 *  by implementing their client + extending this switch (no other file changes). */
@Injectable()
export class CloudProviderFactory {
  constructor(private readonly hetzner: HetznerApiClient) {}

  get(provider: string): CloudProvider {
    if (provider === "hetzner") return this.hetzner;
    throw new BadRequestException(`provider not yet supported: ${provider}`);
  }
}

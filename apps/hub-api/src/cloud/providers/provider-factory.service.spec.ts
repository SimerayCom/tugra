import { BadRequestException } from "@nestjs/common";
import { CloudProviderFactory } from "./provider-factory.service";
import { HetznerApiClient } from "./hetzner.client";
import { DigitalOceanApiClient } from "./digitalocean.client";
import { VultrApiClient } from "./vultr.client";

describe("CloudProviderFactory", () => {
  const hetzner = new HetznerApiClient();
  const digitalocean = new DigitalOceanApiClient();
  const vultr = new VultrApiClient();
  const factory = new CloudProviderFactory(hetzner, digitalocean, vultr);

  it("returns the matching client per provider", () => {
    expect(factory.get("hetzner")).toBe(hetzner);
    expect(factory.get("digitalocean")).toBe(digitalocean);
    expect(factory.get("vultr")).toBe(vultr);
  });
  it("BadRequest for an unknown provider", () => {
    expect(() => factory.get("aws")).toThrow(BadRequestException);
  });
});

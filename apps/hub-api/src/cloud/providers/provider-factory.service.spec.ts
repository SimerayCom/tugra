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
  it("getPrices: the read-only price client of Hetzner, DigitalOcean and Vultr, none for others", () => {
    expect(factory.getPrices("hetzner")).toBe(hetzner);
    expect(factory.getPrices("digitalocean")).toBe(digitalocean);
    expect(factory.getPrices("vultr")).toBe(vultr);
    expect(factory.getPrices("aws")).toBeNull();
  });
  it("getPlans (rescale) stays Hetzner-only", () => {
    expect(factory.getPlans("hetzner")).toBe(hetzner);
    expect(factory.getPlans("digitalocean")).toBeNull();
    expect(factory.getPlans("vultr")).toBeNull();
  });
  it("BadRequest for an unknown provider", () => {
    expect(() => factory.get("aws")).toThrow(BadRequestException);
  });
});

import { ProvisionServerSchema } from "./dto";

const base = { teamId: "t1", name: "web", cloudCredentialId: "cc1", location: "nbg1", serverType: "cx22" };

describe("ProvisionServerSchema", () => {
  it.each(["hetzner", "digitalocean", "vultr"])("accepts provider %s", (provider) => {
    expect(ProvisionServerSchema.safeParse({ ...base, provider }).success).toBe(true);
  });
  it("rejects an unknown provider", () => {
    expect(ProvisionServerSchema.safeParse({ ...base, provider: "aws" }).success).toBe(false);
  });
});

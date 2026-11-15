import { SetComposeNetworksSchema } from "./dto";

describe("SetComposeNetworksSchema", () => {
  const row = (over = {}) => ({ network: "svc-search", service: "meilisearch", aliases: ["meilisearch"], ...over });

  it("accepts a valid replace-set and an empty list", () => {
    expect(SetComposeNetworksSchema.safeParse({ networks: [row()] }).success).toBe(true);
    expect(SetComposeNetworksSchema.safeParse({ networks: [] }).success).toBe(true);
  });
  it("refuses reserved, shared and non-DNS network names", () => {
    for (const network of ["tugra-proxy", "tugra-net", "tugra-apps", "bridge", "host", "default", "Bad_Name", "-x", "tugra-anything"]) {
      expect(SetComposeNetworksSchema.safeParse({ networks: [row({ network })] }).success).toBe(false);
    }
  });
  it("refuses bad aliases, service names and unknown keys", () => {
    expect(SetComposeNetworksSchema.safeParse({ networks: [row({ aliases: ["tugra-x"] })] }).success).toBe(false);
    expect(SetComposeNetworksSchema.safeParse({ networks: [row({ aliases: ["a_b"] })] }).success).toBe(false);
    expect(SetComposeNetworksSchema.safeParse({ networks: [row({ aliases: ["a", "a"] })] }).success).toBe(false);
    expect(SetComposeNetworksSchema.safeParse({ networks: [row({ aliases: ["a", "b", "c", "d", "e"] })] }).success).toBe(false);
    expect(SetComposeNetworksSchema.safeParse({ networks: [row({ service: "a b" })] }).success).toBe(false);
    expect(SetComposeNetworksSchema.safeParse({ networks: [{ ...row(), extra: 1 }] }).success).toBe(false);
  });
  it("caps at 8 rows and refuses a service joining the same network twice", () => {
    const many = Array.from({ length: 9 }, (_, i) => row({ network: `n${i}` }));
    expect(SetComposeNetworksSchema.safeParse({ networks: many }).success).toBe(false);
    expect(SetComposeNetworksSchema.safeParse({ networks: [row(), row()] }).success).toBe(false);
  });
});

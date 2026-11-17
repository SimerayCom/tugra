import { containerPrefixesOf, validContainerPrefix } from "./container-prefix";

describe("container name prefix", () => {
  it("accepts what Coolify 4.7.5 allows (lowercase, digits, single hyphens, up to 30) and older plain names", () => {
    for (const ok of ["shop", "my-shop-2", "a", "a".repeat(30), "Shop_1", "9lives"]) expect([ok, validContainerPrefix(ok)]).toEqual([ok, true]);
  });
  it("refuses anything that is not a plain docker-name-safe token", () => {
    for (const bad of ["", " shop", "shop ", "sh op", "-shop", "_shop", "shop;id", "a$(b)", "a'b", "a/b", "a:b", "a.b", "../x", "a".repeat(65), "shop\n", 5, null, undefined, {}]) {
      expect([bad, validContainerPrefix(bad)]).toEqual([bad, false]);
    }
  });
  it("reads the prefixes of the app items of a stored plan, skipping everything malformed", () => {
    const m = containerPrefixesOf([
      { itemRef: "app:s:a", kind: "app", proposed: { containerPrefix: "shop" } },
      { itemRef: "app:s:b", kind: "app", proposed: {} },
      { itemRef: "app:s:c", kind: "app", proposed: { containerPrefix: "no good" } },
      { itemRef: "app:s:d", kind: "app", proposed: null },
      { itemRef: "database:s:e", kind: "database", proposed: { containerPrefix: "db" } },
      { kind: "app", proposed: { containerPrefix: "x" } },
      null,
    ]);
    expect([...m]).toEqual([["app:s:a", "shop"]]);
    expect(containerPrefixesOf(undefined).size).toBe(0);
    expect(containerPrefixesOf("nope").size).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import worldTopology from "./geo/world-countries-110m.json";
import { alpha2ToNumeric, numericToAlpha2, KNOWN_ALPHA2 } from "./country-codes";

describe("alpha2ToNumeric", () => {
  it.each([["US", "840"], ["DE", "276"], ["TR", "792"], ["GB", "826"], ["FR", "250"], ["JP", "392"], ["BR", "076"], ["AU", "036"], ["IN", "356"], ["CN", "156"]])("%s -> %s", (a, n) => {
    expect(alpha2ToNumeric(a)).toBe(n);
  });
  it("is case/space tolerant and null for overflow, unknown and malformed codes", () => {
    expect(alpha2ToNumeric(" tr ")).toBe("792");
    for (const bad of ["ZZ", "XX", "", "USA", "1", "  ", undefined as unknown as string, null as unknown as string]) expect(alpha2ToNumeric(bad)).toBeNull();
  });
  it("has 249 unique alpha-2 <-> numeric pairs that round-trip", () => {
    expect(KNOWN_ALPHA2).toHaveLength(249);
    const nums = new Set(KNOWN_ALPHA2.map((a) => alpha2ToNumeric(a)));
    expect(nums.size).toBe(249);
    for (const a of KNOWN_ALPHA2) expect(numericToAlpha2(alpha2ToNumeric(a)!)).toBe(a);
  });
  it("numericToAlpha2 pads ids and rejects empties", () => {
    expect(numericToAlpha2("36")).toBe("AU");
    expect(numericToAlpha2(840)).toBe("US");
    expect(numericToAlpha2(undefined)).toBeNull();
    expect(numericToAlpha2("")).toBeNull();
  });
  it("covers every id-bearing country feature in the bundled world-atlas topology, with a matching English name", () => {
    const geoms = (worldTopology as unknown as { objects: { countries: { geometries: { id?: string; properties: { name: string } }[] } } }).objects.countries.geometries;
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    const withId = geoms.filter((g) => g.id);
    expect(withId.length).toBeGreaterThan(170);
    for (const g of withId) {
      const a2 = numericToAlpha2(g.id);
      expect(a2, `${g.id} ${g.properties.name}`).not.toBeNull();
      expect(alpha2ToNumeric(a2!)).toBe(g.id);
    }
    // Spot-check names for the large/common ones so a transposed digit cannot hide.
    const nameOf = (id: string) => geoms.find((g) => g.id === id)!.properties.name;
    expect(dn.of("US")).toMatch(/United States/); expect(nameOf("840")).toMatch(/United States/);
    expect(nameOf("276")).toBe("Germany");
    expect(nameOf("792")).toBe("Turkey");
    expect(nameOf("826")).toBe("United Kingdom");
    expect(nameOf("250")).toBe("France");
  });
});

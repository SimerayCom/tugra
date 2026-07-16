import { EDITIONS, editionAtLeast, normalizeEdition } from "./editions";

describe("EDITIONS ordering", () => {
  it("is community < pro < cloud", () => {
    expect(EDITIONS).toEqual(["community", "pro", "cloud"]);
  });
});

describe("normalizeEdition", () => {
  it("passes through known editions", () => {
    for (const e of EDITIONS) expect(normalizeEdition(e)).toBe(e);
  });
  it("defaults unknown/empty/nullish to community (fail-safe)", () => {
    for (const bad of ["", "enterprise", "COMMUNITY", " pro", undefined, null]) {
      expect(normalizeEdition(bad)).toBe("community");
    }
  });
});

describe("editionAtLeast", () => {
  it("satisfies its own tier and every lower tier", () => {
    expect(editionAtLeast("community", "community")).toBe(true);
    expect(editionAtLeast("pro", "community")).toBe(true);
    expect(editionAtLeast("pro", "pro")).toBe(true);
    expect(editionAtLeast("cloud", "community")).toBe(true);
    expect(editionAtLeast("cloud", "pro")).toBe(true);
    expect(editionAtLeast("cloud", "cloud")).toBe(true);
  });
  it("does not satisfy a higher required tier", () => {
    expect(editionAtLeast("community", "pro")).toBe(false);
    expect(editionAtLeast("community", "cloud")).toBe(false);
    expect(editionAtLeast("pro", "cloud")).toBe(false);
  });
});

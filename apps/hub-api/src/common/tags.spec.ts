import { normalizeTags } from "./tags";

describe("normalizeTags", () => {
  it("lowercases, trims, dedupes, sorts and drops empties", () => {
    expect(normalizeTags(["PROD", " staging ", "prod", "", "   "])).toEqual([
      "prod",
      "staging",
    ]);
  });

  it("collapses invalid characters into hyphens and strips edge hyphens", () => {
    expect(normalizeTags(["a b", "v2.1", "--x--", "API_v2"])).toEqual([
      "a-b",
      "api-v2",
      "v2-1",
      "x",
    ]);
  });

  it("caps the list at 20 tags", () => {
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
    expect(normalizeTags(many)).toHaveLength(20);
  });

  it("returns an empty array when everything normalizes away", () => {
    expect(normalizeTags(["", "  ", "!!!"])).toEqual([]);
  });
});

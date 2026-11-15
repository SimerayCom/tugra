import { CUSTOM_LABEL_KEY_RE, CUSTOM_LABEL_LIMITS, assertSafeCustomLabels, customContainerLabelFlags, customLabelArgs } from "./custom-labels";

describe("assertSafeCustomLabels", () => {
  it("returns {} for null / undefined", () => {
    expect(assertSafeCustomLabels(null)).toEqual({});
    expect(assertSafeCustomLabels(undefined)).toEqual({});
  });
  it("accepts ordinary labels", () => {
    const m = { team: "core", "com.example/env": "prod", "a@b:c-d_e": "" };
    expect(assertSafeCustomLabels(m)).toEqual(m);
  });
  it("rejects non-objects and non-string values", () => {
    expect(() => assertSafeCustomLabels([])).toThrow(/key\/value object/);
    expect(() => assertSafeCustomLabels("x")).toThrow(/key\/value object/);
    expect(() => assertSafeCustomLabels({ a: 1 })).toThrow(/"a" value must be a string/);
  });
  it("validates the key charset", () => {
    for (const k of ["a=b", "a b", "-a", ".a", "a'b", 'a"b', "a\nb", "a$b", "a`b"]) {
      expect(() => assertSafeCustomLabels({ [k]: "v" })).toThrow(/invalid|1-128/);
    }
    expect(CUSTOM_LABEL_KEY_RE.test("ok.key/1")).toBe(true);
  });
  it("enforces count, key, value and total caps", () => {
    const many = Object.fromEntries(Array.from({ length: CUSTOM_LABEL_LIMITS.maxCount + 1 }, (_, i) => [`k${i}`, "v"]));
    expect(() => assertSafeCustomLabels(many)).toThrow(/at most 32/);
    expect(() => assertSafeCustomLabels({ ["a".repeat(129)]: "v" })).toThrow(/1-128/);
    expect(() => assertSafeCustomLabels({ a: "x".repeat(1025) })).toThrow(/longer than 1024/);
    const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "x".repeat(1000)]));
    expect(() => assertSafeCustomLabels(big)).toThrow(/16384 bytes/);
  });
  it("rejects control characters in a value", () => {
    expect(() => assertSafeCustomLabels({ a: "x\ny" })).toThrow(/control characters/);
    expect(() => assertSafeCustomLabels({ a: "x\u0000" })).toThrow(/control characters/);
  });
  it("rejects reserved namespaces naming the key", () => {
    expect(() => assertSafeCustomLabels({ "traefik.x": "1" })).toThrow(/"traefik\.x" is in the reserved traefik\.\* namespace/);
    expect(() => assertSafeCustomLabels({ "Tugra.y": "1" })).toThrow(/"Tugra\.y"/);
    expect(() => assertSafeCustomLabels({ "com.docker.compose.project": "1" })).toThrow(/com\.docker\.compose\./);
  });
  it("rejects case-insensitive duplicates", () => {
    expect(() => assertSafeCustomLabels({ Foo: "1", foo: "2" })).toThrow(/duplicates "Foo"/);
  });
  it("refuses a collision with a raw --label in dockerOptions (case-insensitive)", () => {
    expect(() => assertSafeCustomLabels({ Team: "x" }, { dockerOptions: "--label team=y" })).toThrow(
      /label "Team" is already set via --label in Custom Docker options; remove one/,
    );
    expect(() => assertSafeCustomLabels({ team: "x" }, { dockerOptions: "--memory=64m -lother=1" })).not.toThrow();
    expect(() => assertSafeCustomLabels({ team: "x" }, { dockerOptions: null })).not.toThrow();
  });
});

describe("customLabelArgs / customContainerLabelFlags", () => {
  it("is empty for null / {}", () => {
    expect(customLabelArgs(null)).toBe("");
    expect(customLabelArgs(undefined)).toBe("");
    expect(customLabelArgs({})).toBe("");
    expect(customContainerLabelFlags({}, "--container-label")).toEqual([]);
  });
  it("sorts keys and shell-quotes every pair", () => {
    expect(customLabelArgs({ b: "2", a: "1" })).toBe("--label 'a=1' --label 'b=2'");
  });
  it("keeps $, backticks, quotes, spaces and empty values literal", () => {
    expect(customLabelArgs({ k: "a $HOME `id` \"q\" 'x' y" })).toBe(`--label 'k=a $HOME \`id\` "q" '\\''x'\\'' y'`);
    expect(customLabelArgs({ k: "" })).toBe("--label 'k='");
  });
  it("fails closed on a reserved key in a hand-edited row", () => {
    expect(() => customLabelArgs({ "traefik.enable": "true" })).toThrow(/reserved/);
    expect(() => customContainerLabelFlags({ "tugra.role": "x" }, "--container-label")).toThrow(/reserved/);
  });
  it("uses the requested flag", () => {
    expect(customContainerLabelFlags({ a: "1" }, "--container-label-add")).toEqual(["--container-label-add 'a=1'"]);
  });
});

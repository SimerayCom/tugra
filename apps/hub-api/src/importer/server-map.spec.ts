import { UNKNOWN_SERVER_REF, hasServerMap, placementFor, placementTargets, serverRefOfItemRef, unplacedRefs } from "./server-map";
import { mappingHashOf } from "./import-mapping";

describe("server-map helpers", () => {
  const map = { "src-a": "tgt-1", "src-b": "tgt-2" };
  it("placementFor: mapped, unmapped and unknown refs; prototype names never resolve", () => {
    expect(placementFor("def", map, "src-a")).toBe("tgt-1");
    expect(placementFor("def", map, "src-z")).toBe("def");
    expect(placementFor("def", map, undefined)).toBe("def");
    expect(placementFor("def", { ...map, [UNKNOWN_SERVER_REF]: "tgt-9" }, undefined)).toBe("tgt-9");
    expect(placementFor("def", { [UNKNOWN_SERVER_REF]: "tgt-9" }, "src-z")).toBe("def");
    expect(placementFor("def", {}, undefined)).toBe("def");
    expect(placementFor("def", undefined, "src-a")).toBe("def");
    expect(placementFor("def", map, "constructor")).toBe("def");
    expect(placementFor("def", map, "toString")).toBe("def");
  });
  it("placementTargets: default first, each target once", () => {
    expect(placementTargets("def", { a: "t1", b: "t1", c: "def", d: "t2" })).toEqual(["def", "t1", "t2"]);
    expect(placementTargets("def", null)).toEqual(["def"]);
  });
  it("unplacedRefs: [] without a map, sorted unique refs with one, an unknown placement is reported as `_`", () => {
    expect(unplacedRefs(undefined, ["a", "b", undefined])).toEqual([]);
    expect(unplacedRefs({}, ["a"])).toEqual([]);
    expect(unplacedRefs(map, ["src-b", "z", "y", "z", undefined, null, "toString"])).toEqual(["_", "toString", "y", "z"]);
    expect(unplacedRefs({ ...map, _: "tgt-9" }, ["src-a", undefined])).toEqual([]);
  });
  it("hasServerMap", () => {
    expect(hasServerMap({})).toBe(false);
    expect(hasServerMap(null)).toBe(false);
    expect(hasServerMap(map)).toBe(true);
  });
  it("serverRefOfItemRef reads the middle part, `_` is unknown", () => {
    expect(serverRefOfItemRef("app:srv-1:uuid")).toBe("srv-1");
    expect(serverRefOfItemRef("volume:srv-1:a:b")).toBe("srv-1");
    expect(serverRefOfItemRef("app:_:uuid")).toBeUndefined();
    expect(serverRefOfItemRef("junk")).toBeUndefined();
  });
});

describe("mappingHashOf: serverMap binding", () => {
  const norm = { items: {}, projects: {}, gitSources: {}, acks: [] };
  const i = { planHash: "p", targetServerId: "t", reconcile: false };
  it("an absent or empty map leaves the hash byte-identical; a non-empty map binds it, order-independently", () => {
    const plain = mappingHashOf(norm, i);
    expect(mappingHashOf(norm, { ...i, serverMap: {} })).toBe(plain);
    expect(mappingHashOf(norm, { ...i, serverMap: null })).toBe(plain);
    const a = mappingHashOf(norm, { ...i, serverMap: { x: "1", y: "2" } });
    expect(a).not.toBe(plain);
    expect(mappingHashOf(norm, { ...i, serverMap: { y: "2", x: "1" } })).toBe(a);
    expect(mappingHashOf(norm, { ...i, serverMap: { x: "1", y: "3" } })).not.toBe(a);
  });
});

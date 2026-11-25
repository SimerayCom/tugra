import { z } from "zod";
import "./zod-compat";
import { guardedRecord } from "./zod-record";

const Key = z
  .string()
  .regex(/^[a-z]{1,12}$/)
  .refine((k) => k !== "constructor", "reserved key");
const schema = guardedRecord(Key, z.string());
const body = (json: string) => JSON.parse(json) as unknown;

describe("guardedRecord", () => {
  it("parses like z.record", () => {
    expect(schema.parse({ a: "x", b: "y" })).toEqual({ a: "x", b: "y" });
    expect(schema.safeParse({ "A!": "x" }).success).toBe(false);
    expect(schema.safeParse({ constructor: "x" }).success).toBe(false);
    expect(schema.safeParse({ a: 1 }).success).toBe(false);
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });

  it("refuses an own __proto__ key when the key schema rejects it (zod 4 would drop it silently)", () => {
    const r = schema.safeParse(body('{"a":"x","__proto__":"y"}'));
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => `${i.path.join(".")}|${i.message}`)).toEqual(["__proto__|Invalid"]);
    expect(({} as Record<string, unknown>).y).toBeUndefined();
  });

  it("keeps the reserved-name message", () => {
    const r = schema.safeParse({ constructor: "x" });
    expect(r.error?.issues[0]?.message).toBe("reserved key");
  });

  it("a record field behind it is still required in an object", () => {
    const o = z.object({ params: schema });
    expect(o.safeParse({}).error?.issues.map((i) => `${i.path.join(".")}|${i.message}`)).toEqual(["params|Required"]);
    expect(o.safeParse({ params: { a: "x" } }).success).toBe(true);
  });

  it("a key schema that accepts __proto__ drops it, never assigns it", () => {
    const loose = guardedRecord(z.string().min(1), z.string());
    const out = loose.parse(body('{"a":"x","__proto__":"y"}')) as Record<string, string>;
    expect(Object.keys(out)).toEqual(["a"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

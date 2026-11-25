import { z } from "zod";
import "./zod-compat";

const msgs = (schema: z.ZodType, value: unknown): string[] => {
  const r = schema.safeParse(value);
  return r.success ? ["OK"] : r.error.issues.map((i) => `${i.path.join(".")}|${i.message}`);
};
const obj = (shape: z.ZodRawShape) => z.object(shape);

describe("zod validation messages keep the wording the API has always returned", () => {
  it("type errors", () => {
    expect(msgs(obj({ a: z.string() }), {})).toEqual(["a|Required"]);
    expect(msgs(obj({ a: z.string() }), { a: 1 })).toEqual(["a|Expected string, received number"]);
    expect(msgs(obj({ a: z.string() }), { a: null })).toEqual(["a|Expected string, received null"]);
    expect(msgs(obj({ a: z.boolean() }), { a: "true" })).toEqual(["a|Expected boolean, received string"]);
    expect(msgs(obj({ a: z.array(z.string()) }), { a: "x" })).toEqual(["a|Expected array, received string"]);
    expect(msgs(obj({ a: z.array(z.string()) }), { a: ["x", 1] })).toEqual(["a.1|Expected string, received number"]);
    expect(msgs(obj({ a: z.object({ b: z.string() }) }), { a: [] })).toEqual(["a|Expected object, received array"]);
    expect(msgs(z.object({}), null)).toEqual(["|Expected object, received null"]);
    expect(msgs(z.record(z.string(), z.number()), [])).toEqual(["|Expected object, received array"]);
    expect(msgs(obj({ a: z.number().int() }), { a: 1.5 })).toEqual(["a|Expected integer, received float"]);
    expect(msgs(obj({ a: z.number().int() }), { a: "1" })).toEqual(["a|Expected number, received string"]);
    expect(msgs(obj({ a: z.coerce.number() }), { a: "abc" })).toEqual(["a|Expected number, received nan"]);
    expect(msgs(obj({ a: z.date() }), { a: "x" })).toEqual(["a|Expected date, received string"]);
    expect(msgs(obj({ a: z.coerce.date() }), { a: "x" })).toEqual(["a|Invalid date"]);
  });

  it("size errors", () => {
    expect(msgs(obj({ a: z.string().min(3) }), { a: "x" })).toEqual(["a|String must contain at least 3 character(s)"]);
    expect(msgs(obj({ a: z.string().max(2) }), { a: "xxxx" })).toEqual(["a|String must contain at most 2 character(s)"]);
    expect(msgs(obj({ a: z.string().length(2) }), { a: "xxxx" })).toEqual(["a|String must contain exactly 2 character(s)"]);
    expect(msgs(obj({ a: z.number().min(5) }), { a: 1 })).toEqual(["a|Number must be greater than or equal to 5"]);
    expect(msgs(obj({ a: z.number().gt(5) }), { a: 5 })).toEqual(["a|Number must be greater than 5"]);
    expect(msgs(obj({ a: z.number().max(5) }), { a: 9 })).toEqual(["a|Number must be less than or equal to 5"]);
    expect(msgs(obj({ a: z.number().positive() }), { a: -1 })).toEqual(["a|Number must be greater than 0"]);
    expect(msgs(obj({ a: z.number().multipleOf(5) }), { a: 3 })).toEqual(["a|Number must be a multiple of 5"]);
    expect(msgs(obj({ a: z.array(z.string()).min(1) }), { a: [] })).toEqual(["a|Array must contain at least 1 element(s)"]);
    expect(msgs(obj({ a: z.array(z.string()).max(1) }), { a: ["a", "b"] })).toEqual(["a|Array must contain at most 1 element(s)"]);
  });

  it("enums, literals, unions and keys", () => {
    expect(msgs(obj({ a: z.enum(["x", "y"]) }), { a: "z" })).toEqual(["a|Invalid enum value. Expected 'x' | 'y', received 'z'"]);
    expect(msgs(obj({ a: z.enum(["x", "y"]) }), {})).toEqual(["a|Required"]);
    expect(msgs(obj({ a: z.enum(["x", "y"]) }), { a: 3 })).toEqual(["a|Expected 'x' | 'y', received number"]);
    expect(msgs(obj({ a: z.literal("x") }), { a: "y" })).toEqual(['a|Invalid literal value, expected "x"']);
    expect(msgs(obj({ a: z.literal(1) }), { a: 2 })).toEqual(["a|Invalid literal value, expected 1"]);
    expect(msgs(obj({ a: z.union([z.string(), z.number()]) }), { a: true })).toEqual(["a|Invalid input"]);
    const du = z.discriminatedUnion("t", [z.object({ t: z.literal("a") }), z.object({ t: z.literal("b") })]);
    expect(msgs(du, { t: "c" })).toEqual(["t|Invalid discriminator value. Expected 'a' | 'b'"]);
    expect(msgs(z.object({ a: z.string() }).strict(), { a: "x", b: 1, c: 2 })).toEqual(["|Unrecognized key(s) in object: 'b', 'c'"]);
    expect(msgs(z.record(z.string().min(2), z.number()), { a: 1 })).toEqual(["a|String must contain at least 2 character(s)"]);
  });

  it("string formats", () => {
    expect(msgs(obj({ a: z.string().email() }), { a: "nope" })).toEqual(["a|Invalid email"]);
    expect(msgs(obj({ a: z.string().url() }), { a: "nope" })).toEqual(["a|Invalid url"]);
    expect(msgs(obj({ a: z.string().datetime() }), { a: "nope" })).toEqual(["a|Invalid datetime"]);
    expect(msgs(obj({ a: z.string().regex(/^a$/) }), { a: "b" })).toEqual(["a|Invalid"]);
    expect(msgs(obj({ a: z.string().startsWith("x") }), { a: "b" })).toEqual(['a|Invalid input: must start with "x"']);
    expect(msgs(obj({ a: z.string().includes("x") }), { a: "b" })).toEqual(['a|Invalid input: must include "x"']);
    expect(msgs(obj({ a: z.ipv4() }), { a: "b" })).toEqual(["a|Invalid ip"]);
  });

  it("explicit messages and refinements are left alone", () => {
    expect(msgs(obj({ a: z.string().min(1, "need a value") }), { a: "" })).toEqual(["a|need a value"]);
    expect(msgs(obj({ a: z.string().refine(() => false) }), { a: "b" })).toEqual(["a|Invalid input"]);
    expect(msgs(obj({ a: z.string().refine(() => false, "boom") }), { a: "b" })).toEqual(["a|boom"]);
  });
});

import { z } from "zod";

/**
 * Validation messages for every zod schema in the hub. Zod 4 reworded all of its default messages
 * ("Required" became "Invalid input: expected string, received undefined", "String must contain at least 3
 * character(s)" became "Too small: expected string to have >=3 characters", …). The 400 bodies the web app, the
 * CLI and API users read carry those strings, so they are pinned to the wording the API has always returned.
 * Anything not listed here (custom `.refine` messages, an explicit message on a check) is untouched, and an
 * unknown issue kind falls through to zod's own text.
 */

type RawIssue = z.core.$ZodRawIssue;

/** zod 3's `getParsedType` names (what "received …" printed). */
function parsedType(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "number") return Number.isNaN(v) ? "nan" : "number";
  if (typeof v === "object") {
    if (Array.isArray(v)) return "array";
    if (v instanceof Date) return "date";
    if (v instanceof Map) return "map";
    if (v instanceof Set) return "set";
    if (typeof (v as { then?: unknown }).then === "function") return "promise";
    return "object";
  }
  return typeof v; // string | boolean | bigint | symbol | function
}

const quoted = (values: readonly unknown[]): string => values.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(" | ");
const json = (v: unknown): string => (typeof v === "bigint" ? `${v}n` : (JSON.stringify(v) ?? String(v)));

function sizeMessage(iss: RawIssue & { code: "too_small" | "too_big" }): string | undefined {
  const small = iss.code === "too_small";
  const bound = String(small ? (iss as z.core.$ZodIssueTooSmall).minimum : (iss as z.core.$ZodIssueTooBig).maximum);
  const exact = (iss as { exact?: boolean }).exact === true;
  const inclusive = (iss as { inclusive?: boolean }).inclusive !== false;
  switch (iss.origin) {
    case "array":
    case "set":
      return `${iss.origin === "set" ? "Set" : "Array"} must contain ${exact ? "exactly" : inclusive ? (small ? "at least" : "at most") : small ? "more than" : "less than"} ${bound} element(s)`;
    case "string":
      return `String must contain ${exact ? "exactly" : inclusive ? (small ? "at least" : "at most") : small ? "over" : "under"} ${bound} character(s)`;
    case "number":
    case "int":
      return `Number must be ${exact ? "exactly equal to " : inclusive ? (small ? "greater than or equal to " : "less than or equal to ") : small ? "greater than " : "less than "}${bound}`;
    case "bigint":
      return `Number must be ${exact ? "exactly equal to " : inclusive ? (small ? "greater than or equal to " : "less than or equal to ") : small ? "greater than " : "less than "}${bound}`;
    case "date":
      return `Date must be ${exact ? "exactly equal to " : inclusive ? (small ? "greater than or equal to " : "smaller than or equal to ") : small ? "greater than " : "smaller than "}${new Date(Number(bound))}`;
    default:
      return undefined;
  }
}

function formatMessage(iss: z.core.$ZodIssueInvalidStringFormat): string {
  const extra = iss as unknown as Record<string, string>;
  switch (iss.format) {
    case "starts_with":
      return `Invalid input: must start with "${extra.prefix}"`;
    case "ends_with":
      return `Invalid input: must end with "${extra.suffix}"`;
    case "includes":
      return `Invalid input: must include "${extra.includes}"`;
    case "regex":
      return "Invalid";
    case "ipv4":
    case "ipv6":
      return "Invalid ip";
    case "cidrv4":
    case "cidrv6":
      return "Invalid cidr";
    default:
      return `Invalid ${iss.format}`;
  }
}

function compatMessage(iss: RawIssue): string | undefined {
  switch (iss.code) {
    case "invalid_type": {
      const expected = String(iss.expected);
      const input = iss.input;
      if (input === undefined) return "Required";
      if (expected === "date" && input instanceof Date) return "Invalid date"; // a coerced date that did not parse
      if (typeof input === "number" && Number.isNaN(input)) return `Expected ${expected === "int" ? "number" : expected}, received nan`;
      if (typeof input === "number" && !Number.isFinite(input)) return "Number must be finite";
      if (expected === "int") return typeof input === "number" ? "Expected integer, received float" : `Expected number, received ${parsedType(input)}`;
      return `Expected ${expected === "record" ? "object" : expected}, received ${parsedType(input)}`;
    }
    case "invalid_value": {
      const values = iss.values;
      const inst = (iss as { inst?: { _zod?: { def?: { type?: string } } } }).inst;
      if (inst?._zod?.def?.type === "enum") {
        const input = iss.input;
        if (input === undefined) return "Required";
        if (values.length > 0 && values.every((v) => typeof v === typeof values[0]) && typeof input !== typeof values[0]) {
          return `Expected ${quoted(values)}, received ${parsedType(input)}`;
        }
        return `Invalid enum value. Expected ${quoted(values)}, received ${typeof input === "string" ? `'${input}'` : String(input)}`;
      }
      return `Invalid literal value, expected ${values.length === 1 ? json(values[0]) : values.map(json).join(" | ")}`;
    }
    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${iss.keys.map((k) => `'${k}'`).join(", ")}`;
    case "too_small":
    case "too_big":
      return sizeMessage(iss as RawIssue & { code: "too_small" | "too_big" });
    case "invalid_format":
      return formatMessage(iss as z.core.$ZodIssueInvalidStringFormat);
    case "not_multiple_of":
      return `Number must be a multiple of ${String(iss.divisor)}`;
    case "invalid_key": {
      // a record key that failed its key schema: report the key schema's own complaint, as before
      const inner = iss.issues[0];
      return inner ? z.core.util.finalizeIssue(inner as RawIssue, undefined, z.core.config()).message : undefined;
    }
    default:
      return undefined; // invalid_union ("Invalid input"), custom, … already read the same
  }
}

export function installZodCompatMessages(): void {
  z.config({ customError: (iss) => compatMessage(iss) });
}

installZodCompatMessages();

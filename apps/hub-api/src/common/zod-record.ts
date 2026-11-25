import { z } from "zod";

/**
 * `z.record(key, value)` for records whose key schema is stricter than "any string".
 *
 * Zod 4 silently drops an own `__proto__` key before the key schema ever sees it; zod 3 ran the key schema on it, so a
 * key schema that cannot accept it (a regex, a reserved-name refinement) turned such a body into a 400. This keeps the
 * 400: if the input carries an own `__proto__` key and the key schema would reject it, that rejection is reported (at
 * the same path, with the key schema's own message). A key schema that accepts `__proto__` behaves as before: the key
 * is dropped and never assigned.
 */
export function guardedRecord<K extends z.core.$ZodRecordKey, V extends z.core.SomeType>(key: K, value: V) {
  return z.preprocess((input, ctx) => {
    if (typeof input === "object" && input !== null && !Array.isArray(input) && Object.prototype.hasOwnProperty.call(input, "__proto__")) {
      const verdict = z.safeParse(key, "__proto__");
      if (!verdict.success) {
        ctx.addIssue({ code: "custom", message: verdict.error.issues[0]?.message ?? "Invalid input", path: ["__proto__"], input });
      }
    }
    return input;
  }, z.record(key, value));
}

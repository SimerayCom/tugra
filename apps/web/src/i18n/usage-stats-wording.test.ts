import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(__dirname, "locales/en");

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

/** The product calls it "usage stats" everywhere a person reads it; the word survives only in the variable name. */
describe("usage stats wording", () => {
  it("no English UI string says telemetry, except as the TUGRA_TELEMETRY variable name", () => {
    const bad: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      for (const s of strings(JSON.parse(readFileSync(path.join(dir, f), "utf8")))) {
        if (/telemetry/i.test(s.replace(/TUGRA_TELEMETRY(_[A-Z]+)*/g, ""))) bad.push(`${f}: ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the forced-off note reads as asked", () => {
    const s = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")) as Record<string, string>;
    expect(s.telemetryForcedOff).toBe("Usage stats are turned off by the server environment (TUGRA_TELEMETRY=0). Remove that variable to let this toggle take effect.");
  });
});

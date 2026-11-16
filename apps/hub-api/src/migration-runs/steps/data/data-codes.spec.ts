import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_EVENT_CODES, isRunCode } from "../../core/run-contract";
import { DATA_CODES } from "./data-contract";
import { PARITY_CODES } from "./verify/db-stats";

/** Every non-spec source file of this lane (the codes the web has to localize come from these). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "testing" ? [] : sources(p);
    return p.endsWith(".ts") && !p.endsWith(".spec.ts") ? [p] : [];
  });
}

const PREFIX = /^(data|data-seed|data-final|freeze|verify)\./;
const found = new Map<string, string>();
for (const file of sources(__dirname)) {
  for (const m of readFileSync(file, "utf8").matchAll(/["'`]((?:data|data-seed|data-final|freeze|verify)(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+)["'`]/g)) found.set(m[1], file);
}

describe("the codes the data steps emit (the web localizes `migrationRun.codes.<code>`)", () => {
  it("finds the vocabulary and every one is a valid run code (lower-case dotted/dashed, at most 80 chars)", () => {
    expect(found.size).toBeGreaterThan(60);
    const bad = [...found.keys()].filter((c) => !isRunCode(c));
    expect(bad).toEqual([]);
  });

  it("every DATA_CODES / PARITY_CODES value appears, with the step's own prefix, and none collides with an engine event code", () => {
    for (const v of [...Object.values(DATA_CODES), ...Object.values(PARITY_CODES)]) {
      expect(isRunCode(v)).toBe(true);
      expect(PREFIX.test(v)).toBe(true);
      expect((ENGINE_EVENT_CODES as readonly string[]).includes(v)).toBe(false);
    }
    const values = Object.values(DATA_CODES);
    expect(new Set(values).size).toBe(values.length);
  });

  it("no emitted code is an engine event code", () => {
    const clash = [...found.keys()].filter((c) => (ENGINE_EVENT_CODES as readonly string[]).includes(c));
    expect(clash).toEqual([]);
  });
});

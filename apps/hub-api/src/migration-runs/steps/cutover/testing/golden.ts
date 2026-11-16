import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Golden files for the hub-built host scripts: the exact text that runs as root on a customer's box is reviewed once
 * and pinned, so any change shows up as a diff in review. `UPDATE_GOLDEN=1 jest <spec>` rewrites them.
 */
const DIR = join(__dirname, "golden");

export function expectGolden(name: string, actual: string): void {
  const file = join(DIR, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, `${actual}\n`);
  }
  if (!existsSync(file)) throw new Error(`missing golden ${name}; run with UPDATE_GOLDEN=1`);
  expect(`${actual}\n`).toBe(readFileSync(file, "utf8"));
}

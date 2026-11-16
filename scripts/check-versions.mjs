#!/usr/bin/env node
// Guard: the root package.json (the core release version) and the published CLI package must carry the
// same version, so `tugra-cli` on npm can never lag the hub it talks to again.
//
//   node scripts/check-versions.mjs   -> root version === packages/cli version
//
// Exits non-zero (and prints every mismatch) on drift. Used by the release workflow and a jest spec.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8")).version;

const versions = { "package.json": read("package.json"), "packages/cli/package.json": read("packages/cli/package.json") };
const problems = [];

if (versions["package.json"] !== versions["packages/cli/package.json"]) {
  problems.push(`version drift: package.json=${versions["package.json"]} but packages/cli/package.json=${versions["packages/cli/package.json"]}`);
}

if (problems.length) {
  for (const p of problems) process.stderr.write(`check-versions: ${p}\n`);
  process.exit(1);
}
process.stdout.write(`check-versions: ok (${versions["package.json"]})\n`);

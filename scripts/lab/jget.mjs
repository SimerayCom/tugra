#!/usr/bin/env node
// jget.mjs <path> [file]   print a value of a JSON document (the LAST non-empty line of stdin/file: the migrator prints
// exactly one JSON result line after its human log). Path: dotted keys, numeric indexes, `*` to map over an array
// (`items.*.state` prints one value per line), `@key=value` to pick the array element whose key equals value
// (`items.@itemRef=volume:_:labsrc:data.state`; the value must not contain a dot). Objects print as JSON; a missing path prints nothing and exits 1.
import { readFileSync } from "node:fs";

const path = process.argv[2];
const file = process.argv[3];
if (!path) { console.error("usage: jget.mjs <path> [file]"); process.exit(2); }
const text = readFileSync(file ?? 0, "utf8");
const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
let doc;
for (let i = lines.length - 1; i >= 0; i--) {
  try { doc = JSON.parse(lines[i]); break; } catch { /* a log line */ }
}
if (doc === undefined) { console.error("no JSON document found"); process.exit(3); }

function walk(v, parts) {
  if (parts.length === 0) return [v];
  const [h, ...rest] = parts;
  if (v === null || v === undefined) return [];
  if (h === "*") return Array.isArray(v) ? v.flatMap((x) => walk(x, rest)) : [];
  if (h.startsWith("@")) {
    const eq = h.indexOf("=");
    const key = h.slice(1, eq);
    const val = h.slice(eq + 1);
    return Array.isArray(v) ? v.filter((x) => x && String(x[key]) === val).flatMap((x) => walk(x, rest)) : [];
  }
  return walk(v[h], rest);
}
const out = walk(doc, path.split(".").filter(Boolean)).filter((x) => x !== undefined);
if (out.length === 0) process.exit(1);
for (const v of out) console.log(typeof v === "object" ? JSON.stringify(v) : String(v));

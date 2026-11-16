#!/usr/bin/env node
// Refresh the vendored Cloudflare edge ranges (packages/shared/src/cloudflare-ips.ts) from Cloudflare's published
// lists. Plain public data, no dependencies. Usage:
//
//   node scripts/refresh-cloudflare-ips.mjs                 # fetch https://www.cloudflare.com/ips-v4 and /ips-v6, rewrite the file
//   node scripts/refresh-cloudflare-ips.mjs --check         # fetch and exit 1 if the vendored file is out of date (writes nothing)
//   node scripts/refresh-cloudflare-ips.mjs --v4-file a --v6-file b   # read the lists from local files (air-gapped)
//
// Fails closed: a list that is empty, has a malformed line or contains an implausibly broad range (wider than /12
// IPv4 or /29 IPv6) is rejected and the file is left untouched, so a bad download can never widen what the hub trusts.
import { readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(here, "../packages/shared/src/cloudflare-ips.ts");
const URL_V4 = "https://www.cloudflare.com/ips-v4";
const URL_V6 = "https://www.cloudflare.com/ips-v6";
const BEGIN = "// BEGIN GENERATED (scripts/refresh-cloudflare-ips.mjs)";
const END = "// END GENERATED";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

async function load(file, url) {
  if (file) return readFileSync(file, "utf8");
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** Parse + validate one published list. Throws on anything unexpected. */
export function parseRanges(text, family, label) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < (family === 4 ? 5 : 3)) throw new Error(`${label}: only ${lines.length} ranges, refusing to use it`);
  const minPrefix = family === 4 ? 12 : 29;
  const maxPrefix = family === 4 ? 32 : 128;
  for (const l of lines) {
    const m = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(l);
    if (!m || isIP(m[1]) !== family) throw new Error(`${label}: malformed range ${JSON.stringify(l)}`);
    const p = Number(m[2]);
    if (p < minPrefix || p > maxPrefix) throw new Error(`${label}: implausible prefix length in ${JSON.stringify(l)}`);
  }
  return lines;
}

export function renderBlock(v4, v6, date) {
  const list = (name, xs) => `export const ${name}: readonly string[] = [\n${xs.map((x) => `  ${JSON.stringify(x)},`).join("\n")}\n];`;
  return [
    BEGIN,
    `export const CLOUDFLARE_IPS_SOURCE_V4 = ${JSON.stringify(URL_V4)};`,
    `export const CLOUDFLARE_IPS_SOURCE_V6 = ${JSON.stringify(URL_V6)};`,
    `export const CLOUDFLARE_IPS_FETCHED_AT = ${JSON.stringify(date)};`,
    "",
    list("CLOUDFLARE_IPV4_RANGES", v4),
    "",
    list("CLOUDFLARE_IPV6_RANGES", v6),
    END,
  ].join("\n");
}

export function replaceBlock(source, block) {
  const a = source.indexOf(BEGIN);
  const b = source.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error("generated block markers not found in cloudflare-ips.ts");
  return source.slice(0, a) + block + source.slice(b + END.length);
}

async function main() {
  const check = process.argv.includes("--check");
  const v4 = parseRanges(await load(arg("--v4-file"), URL_V4), 4, "ips-v4");
  const v6 = parseRanges(await load(arg("--v6-file"), URL_V6), 6, "ips-v6");
  const current = readFileSync(TARGET, "utf8");
  // Keep the recorded date when the ranges themselves did not change, so a no-op refresh leaves no diff.
  const norm = (t) => t.replace(/CLOUDFLARE_IPS_FETCHED_AT = "[^"]*"/, 'CLOUDFLARE_IPS_FETCHED_AT = ""');
  const existing = current.slice(current.indexOf(BEGIN), current.indexOf(END) + END.length);
  const unchanged = norm(existing) === norm(renderBlock(v4, v6, ""));
  if (check) {
    if (!unchanged) {
      console.error("cloudflare-ips.ts is out of date; run: node scripts/refresh-cloudflare-ips.mjs");
      process.exit(1);
    }
    console.log("cloudflare-ips.ts is up to date");
    return;
  }
  if (unchanged) {
    console.log("cloudflare-ips.ts already matches the published lists; nothing to do");
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(TARGET, replaceBlock(current, renderBlock(v4, v6, date)));
  console.log(`updated ${TARGET} (${v4.length} IPv4 + ${v6.length} IPv6 ranges, ${date})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`refresh failed, file left untouched: ${e.message}`);
    process.exit(1);
  });
}

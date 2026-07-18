#!/usr/bin/env node
// Committed release-time runner: builds + signs versions.json (+ detached versions.json.sig) from CLI
// flags, using the pure core compiled to apps/hub-api/dist. Run AFTER `pnpm --filter @tugra/hub-api build`.
// All logic (merge/validate/canonicalize/sign/self-verify) lives in the jest-tested manifest-merge.ts;
// this script only does I/O. It refuses to write anything if the self-verify against the real consumer
// verifier fails, so an unpublishable manifest can never ship.
//
//   UPDATE_SIGNING_KEY=<base64 32-byte seed> node scripts/sign-manifest.mjs \
//     --version 0.2.0 --channel stable \
//     --hub-image ghcr.io/mrcandev/tugra-hub:0.2.0 --web-image ghcr.io/mrcandev/tugra-web:0.2.0 \
//     --agent-amd64 sha256:… --agent-arm64 sha256:… \
//     --changelog-url https://github.com/mrcandev/tugra/releases/tag/v0.2.0 \
//     --published-at 2026-07-18T00:00:00Z [--min-upgrade-from 1.9.0] \
//     [--current ./gh-pages/versions.json] --out-dir ./out

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { buildChannelEntry, signAndSelfVerify } from "../apps/hub-api/dist/update/manifest-merge.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const seedB64 = process.env.UPDATE_SIGNING_KEY;
if (!seedB64) {
  console.error("sign-manifest: UPDATE_SIGNING_KEY env is required (base64 32-byte ed25519 seed)");
  process.exit(1);
}
if (!args.version || !args.channel) {
  console.error("sign-manifest: --version and --channel are required");
  process.exit(1);
}

const agentSha256 = {};
if (args["agent-amd64"]) agentSha256.amd64 = args["agent-amd64"];
if (args["agent-arm64"]) agentSha256.arm64 = args["agent-arm64"];

const entry = buildChannelEntry({
  version: args.version,
  hubImage: args["hub-image"],
  webImage: args["web-image"],
  agentSha256: Object.keys(agentSha256).length ? agentSha256 : undefined,
  minUpgradeFrom: args["min-upgrade-from"],
  publishedAt: args["published-at"],
  changelogUrl: args["changelog-url"],
});

let current = null;
if (args.current && existsSync(args.current)) {
  try {
    current = JSON.parse(await readFile(args.current, "utf8"));
  } catch {
    console.error(`sign-manifest: could not parse current manifest at ${args.current}`);
    process.exit(1);
  }
}

let signed;
try {
  signed = signAndSelfVerify({ current, channel: args.channel, entry, seedB64 });
} catch (e) {
  console.error(`sign-manifest: refusing to publish — sign/self-verify failed: ${e.message}`);
  process.exit(1);
}

const outDir = resolve(args["out-dir"] ?? ".");
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "versions.json"), signed.body); // exact bytes, NO trailing newline
await writeFile(join(outDir, "versions.json.sig"), signed.sig + "\n");

console.log(`sign-manifest: wrote versions.json (${Buffer.byteLength(signed.body)} bytes) + versions.json.sig to ${outDir}`);
console.log(`UPDATE_PUBLISHER_KEY (cross-check against operators' config): ${signed.publicKeyB64}`);

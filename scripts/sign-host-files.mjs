#!/usr/bin/env node
// Release-time runner: builds + signs the HOST FILES manifest (the compose file and installer/updater scripts the
// in-app updater may replace) and lays the publishable `host/<version>/` tree out under --out-dir. Run AFTER
// `pnpm --filter @tugra/hub-api build`. All format/verification logic lives in the jest-tested
// apps/hub-api/src/update/host-files.ts; this script only does I/O, and refuses to write anything the real
// verifier would not accept.
//
//   UPDATE_SIGNING_KEY=<base64 32-byte seed> node scripts/sign-host-files.mjs \
//     --version 0.2.0 [--repo-root .] --out-dir ./out
//
// Writes <out-dir>/host/<version>/{HOSTFILES,HOSTFILES.sig,<each listed file at its repo path>} and prints
//   host-files-digest=<sha256 of HOSTFILES>
// as the LAST stdout line — pass that value to sign-manifest.mjs as --host-files-digest so the signed
// versions.json commits to exactly this manifest.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  HOST_TOP_LEVEL_FILES,
  HOST_FILES_MANIFEST_NAME,
  HOST_FILES_SIG_NAME,
  buildHostFilesManifest,
  hostFilesDigest,
  verifyHostFilesManifest,
} from "../apps/hub-api/dist/update/host-files.js";
import { derivePublicKeyB64, seedToPrivateKey, signDetached } from "../apps/hub-api/dist/update/manifest-merge.js";

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
  console.error("sign-host-files: UPDATE_SIGNING_KEY env is required (base64 32-byte ed25519 seed)");
  process.exit(1);
}
if (!args.version || !args["out-dir"]) {
  console.error("sign-host-files: --version and --out-dir are required");
  process.exit(1);
}
const root = resolve(args["repo-root"] ?? ".");

try {
  const libDir = join(root, "scripts", "lib");
  const libs = (await readdir(libDir)).filter((n) => n.endsWith(".sh")).map((n) => `scripts/lib/${n}`);
  const paths = [...HOST_TOP_LEVEL_FILES, ...libs];
  const files = {};
  for (const p of paths) files[p] = await readFile(join(root, p));

  const manifest = buildHostFilesManifest(args.version, files);
  const priv = seedToPrivateKey(seedB64);
  const sig = signDetached(priv, manifest);
  verifyHostFilesManifest(manifest, sig, derivePublicKeyB64(priv)); // self-verify: never write what we can't verify

  const dir = join(resolve(args["out-dir"]), "host", args.version);
  await mkdir(dir, { recursive: true });
  for (const p of paths) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), files[p]);
  }
  await writeFile(join(dir, HOST_FILES_MANIFEST_NAME), manifest);
  await writeFile(join(dir, HOST_FILES_SIG_NAME), sig + "\n");
  console.log(`sign-host-files: wrote ${paths.length} files + ${HOST_FILES_MANIFEST_NAME}(.sig) to ${dir}`);
  console.log(`host-files-digest=${hostFilesDigest(manifest)}`);
} catch (e) {
  console.error(`sign-host-files: refusing to publish — ${e.message}`);
  process.exit(1);
}

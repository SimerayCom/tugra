// Standalone builds (next.config `output: "standalone"`, what the release image ships): Next's own generated
// server.js hands the build-time config to the runtime through __NEXT_PRIVATE_STANDALONE_CONFIG. We boot Next
// through `next()` instead, which (a) prints a misleading `"next start" does not work with "output: standalone"`
// warning without that variable and (b) would re-evaluate next.config.mjs at runtime. This returns the value
// to set, read from the manifest the build wrote next to .next — or undefined when there is none (a plain
// `next build` tree, or the variable is already set), in which case nothing changes.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function standaloneConfigEnv(dir, env = process.env, read = readFileSync) {
  if (env.__NEXT_PRIVATE_STANDALONE_CONFIG) return undefined;
  try {
    const manifest = JSON.parse(read(join(dir, ".next", "required-server-files.json"), "utf8"));
    const config = manifest?.config;
    if (config && config.output === "standalone") return JSON.stringify(config);
  } catch {
    // no manifest / unreadable: fall back to Next's normal config loading
  }
  return undefined;
}

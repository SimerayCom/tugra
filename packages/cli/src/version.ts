import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * This CLI's own release version. Read from the package's own package.json (one level above both `src/` and
 * `dist/`, and always shipped with the npm package) so the number printed by `tugra --version` can never
 * drift from the published version.
 */
export const CLI_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * The agent↔hub wire-protocol version this CLI was built against. Compared with the hub's `GET /version`
 * `protocol` to warn on a hub/CLI version skew. Bump only when the CLI is updated for a new protocol.
 */
export const EXPECTED_PROTOCOL = 2;

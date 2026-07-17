/** This CLI's own release version (kept in sync with package.json). */
export const CLI_VERSION = "0.1.0";

/**
 * The agent↔hub wire-protocol version this CLI was built against. Compared with the hub's `GET /version`
 * `protocol` to warn on a hub/CLI version skew. Bump only when the CLI is updated for a new protocol.
 */
export const EXPECTED_PROTOCOL = 2;
